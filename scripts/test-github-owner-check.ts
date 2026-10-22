// Unit tests for the GitHub App connect owner check (#21 §2). Pure; no database access.
// Run: npx tsx --test scripts/test-github-owner-check.ts
//
// global fetch is stubbed per case, so nothing here reaches GitHub.

import { test, after } from 'node:test';
import assert from 'assert';

import {
  assertInstallationNotSuspended,
  assertInstallationOwner,
  buildInstallUrl,
  findUserInstallation,
  revokeUserToken,
  GitHubConnectError,
  type GitHubInstallation,
} from '../lib/githubApp';

// lib/githubApp reads these lazily, inside the functions, so setting them after the
// import is enough — and keeps the test independent of any real App credentials.
process.env.GITHUB_APP_SLUG = 'leguan-test';
process.env.GITHUB_APP_CLIENT_ID = 'Iv1.testclientid';
process.env.GITHUB_APP_CLIENT_SECRET = 'test-client-secret';

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

/** Replaces fetch with a URL-matched table of canned responses. */
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
    if (!route) {
      throw new Error(`Unstubbed fetch: ${url}`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

/** Asserts the thrown error is a GitHubConnectError with this reason. */
async function expectReason(reason: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (err: any) {
    assert.ok(err instanceof GitHubConnectError, `Expected GitHubConnectError, got ${err?.name}: ${err?.message}`);
    assert.strictEqual(err.reason, reason, `Expected reason "${reason}", got "${err.reason}"`);
    return;
  }
  assert.fail(`Expected a ${reason} failure, but the call succeeded`);
}

const orgInstallation: GitHubInstallation = {
  id: 4242,
  accountId: 9001,
  accountLogin: 'acme',
  accountType: 'Organization',
  repositorySelection: 'selected',
  suspended: false,
};

const personalInstallation: GitHubInstallation = {
  id: 4343,
  accountId: 7001,
  accountLogin: 'devperson',
  accountType: 'User',
  repositorySelection: 'selected',
  suspended: false,
};

const rawOrgInstallation = {
  id: 4242,
  account: { id: 9001, login: 'acme', type: 'Organization' },
  repository_selection: 'selected',
  suspended_at: null,
};

function userInstallationsBody(installations: unknown[]) {
  return { total_count: installations.length, installations };
}

// ---------------------------------------------------------------------------
// Check one: the installation must appear in the authorizing user's own list.
// installation_id arrives as a forgeable URL parameter.
// ---------------------------------------------------------------------------

test('forged installation_id is not found in /user/installations', async () => {
  stubFetch([{ match: '/user/installations', status: 200, body: userInstallationsBody([rawOrgInstallation]) }]);
  const found = await findUserInstallation('tok', 999999);
  assert.strictEqual(found, null);
});

test('a listed installation is mapped with its numeric account id', async () => {
  stubFetch([{ match: '/user/installations', status: 200, body: userInstallationsBody([rawOrgInstallation]) }]);
  const found = await findUserInstallation('tok', 4242);
  assert.deepStrictEqual(found, orgInstallation);
});

test('an unsupported account type is refused, not coerced', async () => {
  stubFetch([
    {
      match: '/user/installations',
      status: 200,
      body: userInstallationsBody([
        { ...rawOrgInstallation, account: { id: 9001, login: 'acme', type: 'Enterprise' } },
      ]),
    },
  ]);
  await expectReason('unsupported_account', () => findUserInstallation('tok', 4242));
});

test('a 500 from /user/installations is a transport failure, not a verdict', async () => {
  stubFetch([{ match: '/user/installations', status: 500, body: {} }]);
  await expectReason('installations_lookup_failed', () => findUserInstallation('tok', 4242));
});

// ---------------------------------------------------------------------------
// Check two: the user must OWN the installation's account.
// ---------------------------------------------------------------------------

test('personal install: the account holder passes', async () => {
  stubFetch([]);
  await assertInstallationOwner('tok', { id: 7001, login: 'devperson' }, personalInstallation);
  assert.strictEqual(calls.length, 0, 'A personal install needs no org call');
});

test('personal install: another user with the same login shape is refused', async () => {
  stubFetch([]);
  await expectReason('not_owner', () =>
    assertInstallationOwner('tok', { id: 7002, login: 'devperson' }, personalInstallation)
  );
});

test('org install: an active admin whose org id matches passes', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/acme',
      status: 200,
      body: { state: 'active', role: 'admin', organization: { id: 9001, login: 'acme' } },
    },
  ]);
  await assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation);
});

test('org install: a plain member is refused', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/acme',
      status: 200,
      body: { state: 'active', role: 'member', organization: { id: 9001, login: 'acme' } },
    },
  ]);
  await expectReason('not_owner', () => assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation));
});

test('org install: a pending admin is refused', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/acme',
      status: 200,
      body: { state: 'pending', role: 'admin', organization: { id: 9001, login: 'acme' } },
    },
  ]);
  await expectReason('not_owner', () => assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation));
});

// The whole point of matching by account.id: a login match is not an identity match.
test('org install: a membership for a DIFFERENT org id is a mismatch', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/acme',
      status: 200,
      body: { state: 'active', role: 'admin', organization: { id: 9002, login: 'acme' } },
    },
  ]);
  await expectReason('account_mismatch', () =>
    assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation)
  );
});

test('org install: a membership with no organization object is a mismatch', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/acme',
      status: 200,
      body: { state: 'active', role: 'admin', organization: null },
    },
  ]);
  await expectReason('account_mismatch', () =>
    assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation)
  );
});

test('org install: 404 (no membership at all) is not_owner', async () => {
  stubFetch([{ match: '/user/memberships/orgs/acme', status: 404, body: {} }]);
  await expectReason('not_owner', () => assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation));
});

// 403 is the signature of the App missing its Members: Read-only permission (§1).
test('org install: 403 is reported as membership_forbidden', async () => {
  stubFetch([{ match: '/user/memberships/orgs/acme', status: 403, body: {} }]);
  await expectReason('membership_forbidden', () =>
    assertInstallationOwner('tok', { id: 7001, login: 'dev' }, orgInstallation)
  );
});

test('org login is URL-encoded in the membership call', async () => {
  stubFetch([
    {
      match: '/user/memberships/orgs/',
      status: 200,
      body: { state: 'active', role: 'admin', organization: { id: 9001, login: 'a b' } },
    },
  ]);
  await assertInstallationOwner('tok', { id: 7001, login: 'dev' }, { ...orgInstallation, accountLogin: 'a b' });
  assert.ok(calls[0].url.endsWith('/user/memberships/orgs/a%20b'), `Unexpected URL: ${calls[0].url}`);
});

// ---------------------------------------------------------------------------
// Check three: a suspended installation cannot be connected at all. Recording it as
// status='suspended' would let the §4 unsuspend webhook activate an invite-flow
// connection no workspace admin ever confirmed, so the connect is refused instead.
// ---------------------------------------------------------------------------

test('a suspended installation is reported as suspended, not as active', async () => {
  stubFetch([
    {
      match: '/user/installations',
      status: 200,
      body: userInstallationsBody([{ ...rawOrgInstallation, suspended_at: '2026-10-01T00:00:00Z' }]),
    },
  ]);
  const found = await findUserInstallation('tok', 4242);
  assert.strictEqual(found?.suspended, true);
});

test('a suspended installation is refused', () => {
  assert.throws(
    () => assertInstallationNotSuspended({ ...orgInstallation, suspended: true }),
    (err: any) => err instanceof GitHubConnectError && err.reason === 'installation_suspended'
  );
});

test('an unsuspended installation passes the guard', () => {
  assertInstallationNotSuspended(orgInstallation);
  assertInstallationNotSuspended(personalInstallation);
});

// ---------------------------------------------------------------------------
// Install URL and token revocation
// ---------------------------------------------------------------------------

test('install URL points at the App slug and carries the encoded state', () => {
  assert.strictEqual(
    buildInstallUrl('ABC123/+'),
    'https://github.com/apps/leguan-test/installations/new?state=ABC123%2F%2B'
  );
});

test('token revocation uses DELETE + basic auth and sends the token in the body', async () => {
  // 200 rather than GitHub's real 204: the Response constructor rejects a body on 204.
  stubFetch([{ match: '/applications/', status: 200, body: {} }]);
  await revokeUserToken('user-token-xyz');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].method, 'DELETE');
  assert.ok(calls[0].url.endsWith('/applications/Iv1.testclientid/token'), `Unexpected URL: ${calls[0].url}`);
  assert.strictEqual(
    calls[0].headers.Authorization,
    `Basic ${Buffer.from('Iv1.testclientid:test-client-secret').toString('base64')}`
  );
  assert.deepStrictEqual(JSON.parse(calls[0].body || '{}'), { access_token: 'user-token-xyz' });
});

test('a failed revocation does not throw (the token expires on its own)', async () => {
  stubFetch([{ match: '/applications/', status: 500, body: {} }]);
  await revokeUserToken('user-token-xyz');
});
