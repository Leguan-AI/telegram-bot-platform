// Unit tests for the answer-time repository tools (#21 §6). Pure; no database, and global
// fetch is stubbed per case, so nothing reaches GitHub.
// Run: npx tsx --test scripts/test-repo-tools.ts

import { test, after } from 'node:test';
import assert from 'assert';
import { generateKeyPairSync } from 'node:crypto';

// The session mints a downscoped token, which needs a signable key.
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
process.env.GITHUB_APP_ID = '123456';
process.env.GITHUB_APP_PRIVATE_KEY = privateKey;

import { RepoToolSession, stripSearchQualifiers } from '../lib/repoTools';
import { SENSITIVE_FILE_REPLY } from '../lib/sensitiveFiles';

const REPO = { repoId: 1, fullName: 'acme/api', defaultBranch: 'main' };

interface Call {
  url: string;
  method: string;
  body: string | null;
}

let calls: Call[] = [];
const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

type Route = { match: string; status?: number; body: unknown };

function stub(routes: Route[]) {
  calls = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, method: (init?.method || 'GET').toUpperCase(), body: (init?.body as string) ?? null });
    const route = [...routes].reverse().find((r) => url.includes(r.match));
    if (!route) throw new Error(`Unstubbed fetch: ${url}`);
    const status = route.status ?? 200;
    return new Response(status === 204 ? null : JSON.stringify(route.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

const tokenRoute: Route = { match: '/access_tokens', status: 201, body: { token: 'ghs_x', expires_at: 'later' } };
const shaRoute: Route = { match: '/commits/main', body: { sha: 'deadbeef' } };

function treeRoute(entries: unknown[], truncated = false): Route {
  return { match: '/git/trees/', body: { tree: entries, truncated } };
}

function fileRoute(text: string, path = 'src/auth.ts'): Route {
  return {
    match: `/contents/${path}`,
    body: { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64') },
  };
}

const blob = (path: string, size = 10) => ({ path, type: 'blob', mode: '100644', size });

function session(limits?: any) {
  return new RepoToolSession({ installationId: 42, repos: [REPO], limits });
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

test('the per-answer token is downscoped to the in-scope repos, contents+metadata', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('README.md')])]);
  await session().listTree({});

  const mint = calls.find((c) => c.url.includes('/access_tokens'));
  assert.ok(mint, 'a token should have been minted');
  const body = JSON.parse(mint.body || '{}');
  assert.deepStrictEqual(body.repository_ids, [1]);
  assert.deepStrictEqual(body.permissions, { contents: 'read', metadata: 'read' });
  assert.ok(!('members' in body.permissions), 'an answer-time token must never ask for members');
});

test('the commit and the tree are fetched once per repository per answer', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts'), blob('b.ts'), { path: 'src', type: 'tree', mode: '040000' }])]);
  const s = session();

  await s.listTree({});
  await s.listTree({ path: 'src', depth: 2 });
  await s.listTree({ depth: 3 });

  assert.strictEqual(calls.filter((c) => c.url.includes('/git/trees/')).length, 1, 'one tree fetch');
  assert.strictEqual(calls.filter((c) => c.url.includes('/commits/main')).length, 1, 'one commit resolution');
  assert.strictEqual(calls.filter((c) => c.url.includes('/access_tokens')).length, 1, 'one token');
});

// ---------------------------------------------------------------------------
// list_tree
// ---------------------------------------------------------------------------

test('listings carry type markers and sizes, and respect depth', async () => {
  stub([
    tokenRoute,
    shaRoute,
    treeRoute([
      blob('README.md', 120),
      { path: 'src', type: 'tree', mode: '040000' },
      blob('src/auth.ts', 900),
      blob('src/deep/inner.ts', 20),
      { path: 'vendor', type: 'commit', mode: '160000' },
      { path: 'link.ts', type: 'blob', mode: '120000' },
    ]),
  ]);

  const top = (await session().listTree({ depth: 1 })).content;
  assert.match(top, /file {2}README\.md \(120 bytes\)/);
  assert.match(top, /dir {3}src\//);
  assert.match(top, /sub {3}vendor/);
  assert.match(top, /link {2}link\.ts/);
  assert.ok(!top.includes('inner.ts'), 'depth 1 should not reach src/deep');

  const deeper = (await session().listTree({ depth: 3 })).content;
  assert.match(deeper, /inner\.ts/);
});

test('name-blocked entries are removed before counting and capping', async () => {
  stub([
    tokenRoute,
    shaRoute,
    treeRoute([blob('.env'), blob('a.ts'), blob('b.ts'), blob('apps/.env.local'), blob('c.ts')]),
  ]);

  // A cap of 2 would include .env if it were counted before filtering.
  const result = await session({ maxTreeEntries: 2 }).listTree({ depth: 2 });
  assert.ok(!result.content.includes('.env'), 'blocked entries must not appear');
  assert.match(result.content, /…1 more entries/, 'the marker counts only visible entries');
});

test('a truncated tree says so', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts')], true)]);
  const result = await session().listTree({});
  assert.match(result.content, /truncated/i);
});

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

test('a name-blocked path gets the sensitive reply, never "not found"', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts')])]);
  const result = await session().readFile({ path: 'apps/web/.env.local' });

  assert.strictEqual(result.content, SENSITIVE_FILE_REPLY);
  assert.strictEqual(calls.length, 0, 'it must not even look: the reply cannot depend on existence');
});

test('a missing path is answered from the tree, with no GitHub call', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts')])]);
  const s = session();
  await s.listTree({});
  const before = calls.length;

  const result = await s.readFile({ path: 'nope.ts' });
  assert.match(result.content, /No file at nope\.ts/);
  assert.strictEqual(calls.length, before, 'the tree already knew');
});

test('symlinks and submodules are identified from the tree', async () => {
  stub([
    tokenRoute,
    shaRoute,
    treeRoute([
      { path: 'link.ts', type: 'blob', mode: '120000' },
      { path: 'vendor', type: 'commit', mode: '160000' },
      { path: 'src', type: 'tree', mode: '040000' },
    ]),
  ]);
  const s = session();
  assert.match((await s.readFile({ path: 'link.ts' })).content, /symlink/);
  assert.match((await s.readFile({ path: 'vendor' })).content, /submodule/);
  assert.match((await s.readFile({ path: 'src' })).content, /directory/);
});

test('a file is returned, recorded for provenance, and counted against the budget', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('src/auth.ts')]), fileRoute('export const x = 1;')]);
  const s = session();
  const result = await s.readFile({ path: 'src/auth.ts' });

  assert.match(result.content, /export const x = 1;/);
  assert.deepStrictEqual(s.getReads(), [{ repoFullName: 'acme/api', path: 'src/auth.ts' }]);
  assert.strictEqual(s.getBytesReturned(), 'export const x = 1;'.length);
});

test('an oversized file is truncated with an explicit marker', async () => {
  const big = 'x'.repeat(500);
  stub([tokenRoute, shaRoute, treeRoute([blob('src/auth.ts')]), fileRoute(big)]);
  const result = await session({ maxFileBytes: 100 }).readFile({ path: 'src/auth.ts' });

  assert.match(result.content, /… truncated: src\/auth\.ts is 500 characters, showing the first 100\./);
});

// The cap must not be able to hide a key that sits below it.
test('content rules run on the whole file, before truncation', async () => {
  const withKey = `${'x'.repeat(200)}\nsk-ant-${'a'.repeat(24)}\n`;
  stub([tokenRoute, shaRoute, treeRoute([blob('src/auth.ts')]), fileRoute(withKey)]);
  const result = await session({ maxFileBytes: 50 }).readFile({ path: 'src/auth.ts' });

  assert.strictEqual(result.content, SENSITIVE_FILE_REPLY);
});

test('binary files and LFS pointers are described, not dumped', async () => {
  stub([
    tokenRoute,
    shaRoute,
    treeRoute([blob('logo.png'), blob('big.bin')]),
    {
      match: '/contents/logo.png',
      body: { type: 'file', encoding: 'base64', size: 4, content: Buffer.from([1, 0, 2, 3]).toString('base64') },
    },
    {
      match: '/contents/big.bin',
      body: {
        type: 'file',
        encoding: 'base64',
        size: 60,
        content: Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n').toString('base64'),
      },
    },
  ]);
  const s = session();
  assert.match((await s.readFile({ path: 'logo.png' })).content, /binary file \(4 bytes\)/);
  assert.match((await s.readFile({ path: 'big.bin' })).content, /Git LFS/);
});

test('the per-answer content budget stops further reads', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts'), blob('b.ts')]), fileRoute('y'.repeat(80), 'a.ts'), fileRoute('z'.repeat(80), 'b.ts')]);
  const s = session({ maxAnswerBytes: 100, maxFileBytes: 80 });

  await s.readFile({ path: 'a.ts' });
  const second = await s.readFile({ path: 'b.ts' });
  // 80 of 100 spent; the second read is allowed but clipped to what is left.
  assert.ok(s.getBytesReturned() <= 100, 'the budget must hold');
  assert.match(second.content, /truncated/);

  const third = await s.readFile({ path: 'a.ts' });
  assert.match(third.content, /already received this earlier|reached the amount/);
});

// ---------------------------------------------------------------------------
// search_code
// ---------------------------------------------------------------------------

test('qualifiers are stripped from the model query', () => {
  assert.strictEqual(stripSearchQualifiers('org:acme password'), 'password');
  assert.strictEqual(stripSearchQualifiers('repo:acme/other secret thing'), 'secret thing');
  assert.strictEqual(stripSearchQualifiers('user:someone in:file token'), 'token');
  assert.strictEqual(stripSearchQualifiers('-repo:acme/api hunt'), 'hunt');
  assert.strictEqual(stripSearchQualifiers('language:go handler'), 'handler');
  assert.strictEqual(stripSearchQualifiers('plain query'), 'plain query');
});

test('the search is re-scoped to our own repositories', async () => {
  stub([tokenRoute, { match: '/search/code', body: { items: [] } }]);
  await session().searchCode({ query: 'org:evil password' });

  const search = calls.find((c) => c.url.includes('/search/code'));
  const q = decodeURIComponent(new URL(search!.url).searchParams.get('q') || '');
  assert.strictEqual(q, 'password repo:acme/api');
  assert.ok(!q.includes('org:evil'), 'the injected qualifier must be gone');
});

test('out-of-scope results are dropped even if GitHub returns them', async () => {
  stub([
    tokenRoute,
    {
      match: '/search/code',
      body: {
        items: [
          { path: 'src/a.ts', repository: { id: 1 }, text_matches: [{ fragment: 'const a = 1' }] },
          { path: 'src/b.ts', repository: { id: 999 }, text_matches: [{ fragment: 'const b = 2' }] },
        ],
      },
    },
  ]);
  const result = await session().searchCode({ query: 'const' });

  assert.match(result.content, /src\/a\.ts/);
  assert.ok(!result.content.includes('src/b.ts'), 'a foreign repository id must be dropped');
  assert.match(result.content, /^1 match/);
});

test('hits in blocked files, and snippets holding secrets, are dropped from the count', async () => {
  stub([
    tokenRoute,
    {
      match: '/search/code',
      body: {
        items: [
          { path: '.env', repository: { id: 1 }, text_matches: [{ fragment: 'API_KEY=1' }] },
          { path: 'src/ok.ts', repository: { id: 1 }, text_matches: [{ fragment: 'const ok = true' }] },
          { path: 'src/leak.ts', repository: { id: 1 }, text_matches: [{ fragment: `token = "sk-ant-${'a'.repeat(24)}"` }] },
        ],
      },
    },
  ]);
  const result = await session().searchCode({ query: 'token' });

  assert.ok(!result.content.includes('.env'), 'name-blocked hits must not appear');
  assert.ok(!result.content.includes('leak.ts'), 'a secret-bearing snippet takes its hit with it');
  assert.match(result.content, /^1 match/, 'the count is ours, after filtering');
});

// ---------------------------------------------------------------------------
// Rate limits and result memory (§7 rules 5 and 6)
// ---------------------------------------------------------------------------

test('after a 403 the same bucket stops contacting GitHub', async () => {
  stub([tokenRoute, { match: '/search/code', status: 403, body: {} }]);
  const s = session();

  const first = await s.searchCode({ query: 'alpha' });
  assert.strictEqual(first.isError, true);
  const callsAfterFirst = calls.length;

  const second = await s.searchCode({ query: 'beta' });
  assert.strictEqual(second.isError, true);
  assert.strictEqual(calls.length, callsAfterFirst, 'the second search must not reach GitHub');
});

test('an identical repeat makes no request and returns a pointer', async () => {
  const body = 'export const value = 1;'.repeat(20);
  stub([tokenRoute, shaRoute, treeRoute([blob('src/auth.ts')]), fileRoute(body)]);
  const s = session();

  const first = await s.readFile({ path: 'src/auth.ts' });
  assert.match(first.content, /export const value/);
  const before = calls.length;

  // Equivalent spellings normalise to the same key.
  const again = await s.readFile({ path: './src//auth.ts' });
  assert.strictEqual(calls.length, before, 'a repeat must not reach GitHub');
  assert.match(again.content, /already received this earlier/);
});

test('a repeated not-found returns the same answer, not a pointer', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts')])]);
  const s = session();

  const first = await s.readFile({ path: 'missing.ts' });
  const second = await s.readFile({ path: 'missing.ts' });
  assert.strictEqual(first.content, second.content);
  assert.match(second.content, /No file at missing\.ts/);
});

// ---------------------------------------------------------------------------
// Repository selection
// ---------------------------------------------------------------------------

test('an unknown repository argument is refused with the real choices', async () => {
  stub([tokenRoute]);
  const result = await session().readFile({ repo: 'acme/secret', path: 'a.ts' });
  assert.strictEqual(result.isError, true);
  assert.match(result.content, /acme\/api/);
  assert.strictEqual(calls.length, 0, 'nothing should be fetched for a repository we do not have');
});

test('the short name resolves when it is unambiguous', async () => {
  stub([tokenRoute, shaRoute, treeRoute([blob('a.ts')])]);
  const result = await session().listTree({ repo: 'api' });
  assert.ok(!result.isError, result.content);
});
