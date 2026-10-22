// Unit tests for GitHub App JWT signing and installation tokens (#21 §1). Pure; no
// database access, and global fetch is stubbed per case.
// Run: npx tsx --test scripts/test-github-app-token.ts

import { test, after } from 'node:test';
import assert from 'assert';
import { createVerify, generateKeyPairSync } from 'node:crypto';

import {
  READ_ONLY_REPO_PERMISSIONS,
  canMintInstallationTokens,
  listInstallationRepositories,
  mintAppJwt,
  mintInstallationToken,
  normalizePrivateKey,
  GitHubTokenError,
} from '../lib/githubAppToken';

// A throwaway key pair, generated per run: the real App key never appears in a test.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

process.env.GITHUB_APP_ID = '123456';
process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

interface StubbedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

const calls: StubbedCall[] = [];
const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(routes: Array<{ match: string; status: number; body: unknown }>) {
  calls.length = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({
      url,
      method: (init?.method || 'GET').toUpperCase(),
      headers: (init?.headers || {}) as Record<string, string>,
      body: (init?.body as string) ?? null,
    });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`Unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function decodeSegment(segment: string): any {
  return JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

// ---------------------------------------------------------------------------
// The JWT
// ---------------------------------------------------------------------------

test('the App JWT verifies against the key that signed it', () => {
  const jwt = mintAppJwt();
  const [header, payload, signature] = jwt.split('.');

  const verified = createVerify('RSA-SHA256')
    .update(`${header}.${payload}`)
    .verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));

  assert.ok(verified, 'signature did not verify');
  assert.deepStrictEqual(decodeSegment(header), { alg: 'RS256', typ: 'JWT' });
});

test('iat is backdated and exp stays inside GitHub\'s 10-minute ceiling', () => {
  const now = 1_800_000_000;
  const payload = decodeSegment(mintAppJwt(now).split('.')[1]);

  assert.strictEqual(payload.iss, '123456', 'iss must be the App ID');
  assert.strictEqual(payload.iat, now - 60, 'iat must be backdated 60s for clock drift');
  assert.ok(payload.exp - payload.iat <= 600, 'exp must be within 10 minutes of iat');
  assert.ok(payload.exp > now, 'exp must be in the future');
});

test('a key with escaped newlines signs the same as a real multi-line one', () => {
  const escaped = privateKey.replace(/\n/g, '\\n');
  assert.strictEqual(normalizePrivateKey(escaped), normalizePrivateKey(privateKey));

  process.env.GITHUB_APP_PRIVATE_KEY = escaped;
  const fromEscaped = mintAppJwt(1_800_000_000);
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  const fromReal = mintAppJwt(1_800_000_000);

  assert.strictEqual(fromEscaped, fromReal);
});

test('a malformed key fails without putting the key in the message', () => {
  process.env.GITHUB_APP_PRIVATE_KEY = 'not-a-pem-at-all';
  try {
    mintAppJwt();
    assert.fail('expected signing to fail');
  } catch (err: any) {
    assert.ok(err instanceof GitHubTokenError);
    assert.strictEqual(err.reason, 'app_key_invalid');
    assert.ok(!err.message.includes('not-a-pem-at-all'), 'the key must not be echoed');
  } finally {
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey;
  }
});

test('missing credentials are reported, not guessed at', () => {
  const saved = process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_ID;
  try {
    assert.strictEqual(canMintInstallationTokens(), false);
    assert.throws(() => mintAppJwt(), (err: any) => err.reason === 'app_not_configured');
  } finally {
    process.env.GITHUB_APP_ID = saved;
  }
  assert.strictEqual(canMintInstallationTokens(), true);
});

// ---------------------------------------------------------------------------
// Installation tokens
// ---------------------------------------------------------------------------

test('an unscoped token sends no repository_ids (the picker needs them all)', async () => {
  stubFetch([{ match: '/access_tokens', status: 201, body: { token: 'ghs_x', expires_at: 'later', repository_selection: 'selected' } }]);
  const token = await mintInstallationToken({ installationId: 42 });

  assert.strictEqual(token.token, 'ghs_x');
  assert.strictEqual(token.repositorySelection, 'selected');
  assert.strictEqual(calls[0].method, 'POST');
  assert.ok(calls[0].url.endsWith('/app/installations/42/access_tokens'));
  assert.deepStrictEqual(JSON.parse(calls[0].body || '{}'), {});
});

test('a downscoped token carries the repo ids and contents+metadata only', async () => {
  stubFetch([{ match: '/access_tokens', status: 201, body: { token: 'ghs_y', expires_at: 'later' } }]);
  await mintInstallationToken({
    installationId: 42,
    repositoryIds: [7, 9],
    permissions: { ...READ_ONLY_REPO_PERMISSIONS },
  });

  const sent = JSON.parse(calls[0].body || '{}');
  assert.deepStrictEqual(sent.repository_ids, [7, 9]);
  assert.deepStrictEqual(sent.permissions, { contents: 'read', metadata: 'read' });
  assert.ok(!('members' in sent.permissions), 'an answer-time token must never ask for members');
});

// An omitted list means "all repositories" to GitHub, so an empty one must never be sent:
// a pinned-away topic would otherwise get a token for the whole installation.
test('an empty repository list is refused instead of sent', async () => {
  stubFetch([]);
  await assert.rejects(
    () => mintInstallationToken({ installationId: 42, repositoryIds: [] }),
    (err: any) => err instanceof GitHubTokenError && err.reason === 'empty_repository_scope'
  );
  assert.strictEqual(calls.length, 0, 'nothing should have been sent to GitHub');
});

test('404 and 403 from the token endpoint are distinguished', async () => {
  stubFetch([{ match: '/access_tokens', status: 404, body: {} }]);
  await assert.rejects(
    () => mintInstallationToken({ installationId: 42 }),
    (err: any) => err.reason === 'installation_gone'
  );

  stubFetch([{ match: '/access_tokens', status: 403, body: {} }]);
  await assert.rejects(
    () => mintInstallationToken({ installationId: 42 }),
    (err: any) => err.reason === 'installation_suspended'
  );
});

// ---------------------------------------------------------------------------
// Listing the installation's repositories
// ---------------------------------------------------------------------------

test('repositories are mapped, with a default branch always present', async () => {
  stubFetch([
    {
      match: '/installation/repositories',
      status: 200,
      body: {
        total_count: 2,
        repositories: [
          { id: 1, full_name: 'acme/api', private: true, default_branch: 'trunk', description: 'Backend' },
          { id: 2, full_name: 'acme/empty', private: true, default_branch: null, description: null },
        ],
      },
    },
  ]);

  const repos = await listInstallationRepositories('ghs_x');
  assert.deepStrictEqual(repos, [
    { id: 1, fullName: 'acme/api', private: true, defaultBranch: 'trunk', description: 'Backend' },
    { id: 2, fullName: 'acme/empty', private: true, defaultBranch: 'main', description: null },
  ]);
});

test('a failed listing is reported rather than returning a short list', async () => {
  stubFetch([{ match: '/installation/repositories', status: 500, body: {} }]);
  await assert.rejects(
    () => listInstallationRepositories('ghs_x'),
    (err: any) => err instanceof GitHubTokenError && err.reason === 'repository_list_failed'
  );
});
