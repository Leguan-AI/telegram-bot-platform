// Unit tests for the sensitive-file policy (#21 §6). Pure; no database, no network.
// Run: npx tsx --test scripts/test-sensitive-files.ts
//
// The vectors in "the table from §6" are the issue's own worked examples, reproduced
// exactly. If one of them ever has to change, the issue changes first.

import { test } from 'node:test';
import assert from 'assert';

import {
  checkFile,
  filterListing,
  isNameBlocked,
  normalizeRepoPath,
  SENSITIVE_FILE_REPLY,
} from '../lib/sensitiveFiles';

// ---------------------------------------------------------------------------
// 1. Path normalisation
// ---------------------------------------------------------------------------

test('ordinary paths normalise to themselves', () => {
  assert.deepStrictEqual(normalizeRepoPath('src/auth.ts'), { ok: true, path: 'src/auth.ts' });
  assert.deepStrictEqual(normalizeRepoPath('README.md'), { ok: true, path: 'README.md' });
});

test('leading ./ and doubled slashes collapse', () => {
  assert.deepStrictEqual(normalizeRepoPath('./src/auth.ts'), { ok: true, path: 'src/auth.ts' });
  assert.deepStrictEqual(normalizeRepoPath('src//nested///auth.ts'), {
    ok: true,
    path: 'src/nested/auth.ts',
  });
  assert.deepStrictEqual(normalizeRepoPath('src/./auth.ts'), { ok: true, path: 'src/auth.ts' });
});

test('traversal is rejected, however it is spelled', () => {
  for (const path of ['../secrets', 'src/../../etc/passwd', 'a/b/..', '..']) {
    assert.deepStrictEqual(normalizeRepoPath(path), { ok: false, reason: 'invalid_path' }, path);
  }
});

// A single decode would turn %252e%252e into %2e%2e and stop, letting traversal through.
test('percent-decoding repeats until stable, catching double encoding', () => {
  assert.deepStrictEqual(normalizeRepoPath('%2e%2e/secrets'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath('%252e%252e/secrets'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath('src/%2e%2e/%2e%2e/etc'), { ok: false, reason: 'invalid_path' });
  // And ordinary encoding still decodes.
  assert.deepStrictEqual(normalizeRepoPath('src/my%20file.ts'), { ok: true, path: 'src/my file.ts' });
});

// A sequence decodeURIComponent rejects is not an escape, so there is nothing further to
// unwrap and the raw characters are checked as they stand. Refusing instead would make an
// ordinary filename with a stray `%` unreadable AND silently absent from every listing.
test('a filename containing a stray percent is usable, not refused', () => {
  assert.deepStrictEqual(normalizeRepoPath('README (100%).md'), { ok: true, path: 'README (100%).md' });
  assert.deepStrictEqual(normalizeRepoPath('docs/50%-off.html'), { ok: true, path: 'docs/50%-off.html' });
  assert.deepStrictEqual(normalizeRepoPath('src/%zz'), { ok: true, path: 'src/%zz' });
  assert.strictEqual(isNameBlocked('README (100%).md'), false, 'and it must not vanish from listings');
});

// The point of the fallback is that it gives nothing away: traversal decodes cleanly, so
// it is still caught, and a malformed escape cannot smuggle it past.
test('a stray percent cannot be used to hide traversal', () => {
  assert.deepStrictEqual(normalizeRepoPath('%2e%2e/%zz'), { ok: false, reason: 'invalid_path' });
  // `..%zz` is a literal (odd) filename, not a traversal segment, so it is allowed —
  // what matters is that nothing decodes INTO `..`.
  assert.deepStrictEqual(normalizeRepoPath('..%zz/secrets'), { ok: true, path: '..%zz/secrets' });
  assert.deepStrictEqual(normalizeRepoPath('%zz/../etc'), { ok: false, reason: 'invalid_path' });
  // And the literal path that results is harmless: it is a filename, not a traversal.
  const literal = normalizeRepoPath('a%zzb/c.ts');
  assert.deepStrictEqual(literal, { ok: true, path: 'a%zzb/c.ts' });
});

test('endless nesting is still refused', () => {
  // %2525252e… keeps unwrapping; five passes is the limit.
  assert.deepStrictEqual(normalizeRepoPath('%252525252e%252525252e/x'), {
    ok: false,
    reason: 'invalid_path',
  });
});

test('absolute paths, backslashes and control characters are refused', () => {
  assert.deepStrictEqual(normalizeRepoPath('/etc/passwd'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath('src\\auth.ts'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath('src/auth\u0000.ts'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath('src/auth\u001f.ts'), { ok: false, reason: 'invalid_path' });
  assert.deepStrictEqual(normalizeRepoPath(''), { ok: false, reason: 'invalid_path' });
});

test('paths are NFC-normalised, so both spellings of a name match', () => {
  const composed = normalizeRepoPath('src/café.ts');
  const decomposed = normalizeRepoPath('src/café.ts');
  assert.strictEqual(composed.ok && decomposed.ok && composed.path === decomposed.path, true);
});

// ---------------------------------------------------------------------------
// 2. The §6 table, exactly as the issue writes it
// ---------------------------------------------------------------------------

test('the §6 worked examples', () => {
  const vectors: Array<[string, boolean]> = [
    ['.env.local.example', false],
    ['.env.example.local', true],
    ['apps/web/.env.local', true],
    ['deploy/prod.env', true],
    ['deploy/prod.env.example', false],
    ['secrets.yml.sample', false],
    ['config/credentials.json.template', false],
    ['id_rsa.pub', true],
    ['.ssh/config', true],
  ];

  for (const [path, blocked] of vectors) {
    assert.strictEqual(isNameBlocked(path), blocked, `${path} should be ${blocked ? 'blocked' : 'allowed'}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Filename rules, at any depth and in any casing
// ---------------------------------------------------------------------------

test('filename rules match the basename at any depth', () => {
  for (const path of [
    '.env',
    'apps/web/.env',
    'a/b/c/d/e/.env.production',
    'deploy/docker.env',
    '.envrc',
    'certs/server.pem',
    'certs/server.key',
    'keys/apple.p8',
    'keys/cert.p12',
    'keys/cert.pfx',
    'keys/store.jks',
    'keys/release.keystore',
    'vpn/client.ovpn',
    'home/id_rsa',
    'home/id_dsa',
    'home/id_ecdsa.pub',
    'home/id_ed25519',
    '.npmrc',
    '.yarnrc.yml',
    '.pypirc',
    '.netrc',
    '.pgpass',
    '.htpasswd',
    '.git-credentials',
    '.dockercfg',
    'infra/prod.tfvars',
    'infra/terraform.tfstate',
    'infra/terraform.tfstate.backup',
    'credentials.json',
    'gcp/my-service-account-key.json',
    'secrets.yml',
    'secrets.yaml',
  ]) {
    assert.strictEqual(isNameBlocked(path), true, `${path} should be blocked`);
  }
});

test('matching is case-insensitive', () => {
  assert.strictEqual(isNameBlocked('apps/.ENV.local'), true);
  assert.strictEqual(isNameBlocked('CERTS/Server.PEM'), true);
  assert.strictEqual(isNameBlocked('Home/ID_RSA'), true);
});

test('ordinary files are not caught', () => {
  for (const path of [
    'src/auth.ts',
    'README.md',
    'package.json',
    'docs/environment.md',
    'src/keyboard.tsx',
    'lib/envelope.ts',
    'test/fixtures/secretsmanager.ts',
  ]) {
    assert.strictEqual(isNameBlocked(path), false, `${path} should be allowed`);
  }
});

// ---------------------------------------------------------------------------
// 4. Directory rules and the template exception
// ---------------------------------------------------------------------------

test('directory rules match as a suffix at any depth', () => {
  assert.strictEqual(isNameBlocked('.ssh/config'), true);
  assert.strictEqual(isNameBlocked('home/user/.ssh/known_hosts'), true);
  // Nested, which the literal `.ssh/*` would have missed.
  assert.strictEqual(isNameBlocked('.ssh/keys/work/id'), true);
  assert.strictEqual(isNameBlocked('.aws/credentials'), true);
  assert.strictEqual(isNameBlocked('home/.aws/credentials'), true);
  assert.strictEqual(isNameBlocked('.kube/config'), true);
  assert.strictEqual(isNameBlocked('.docker/config.json'), true);
  // Not the same thing as the blocked ones.
  assert.strictEqual(isNameBlocked('.aws/region.txt'), false);
  assert.strictEqual(isNameBlocked('.docker/Dockerfile'), false);
});

test('the template exception covers every rule, not only .env', () => {
  assert.strictEqual(isNameBlocked('secrets.yml.sample'), false);
  assert.strictEqual(isNameBlocked('config/credentials.json.template'), false);
  assert.strictEqual(isNameBlocked('certs/server.pem.example'), false);
  assert.strictEqual(isNameBlocked('.ssh/config.example'), false);
  assert.strictEqual(isNameBlocked('infra/prod.tfvars.sample'), false);
});

test('the exception is the LAST segment only', () => {
  // `.env.*` still matches, and `local` is not a template suffix.
  assert.strictEqual(isNameBlocked('.env.example.local'), true);
  // `*.pem` still matches, and `pem` is not a template suffix.
  assert.strictEqual(isNameBlocked('certs/server.sample.pem'), true);
});

// Worth pinning because it looks like an oversight and is not: rule 2 names `secrets.yml`
// exactly, so an infixed `sample` leaves nothing for any rule to match. The list is finite
// by design (#21 §6) — it grows by adding patterns, not by loosening the matcher.
test('a name no rule names is allowed, even when it reads like a secret', () => {
  assert.strictEqual(isNameBlocked('secrets.sample.yml'), false);
  assert.strictEqual(isNameBlocked('config/secrets.backup.yml'), false);
});

// ---------------------------------------------------------------------------
// 5. No content scanning — a measured decision, not an omission
//
// #21 §6 also specified regexes over file contents. They were built and then removed:
// ten of thirteen realistic placeholder credentials tripped them, including AWS's own
// documentation example key (AKIAIOSFODNN7EXAMPLE), because a placeholder is written to
// look like the real thing. These tests pin the consequence so it is not re-added by
// accident, and so the trade-off stays visible.
// ---------------------------------------------------------------------------

test('a file is judged by its name alone, whatever it contains', () => {
  // Every one of these is a documentation placeholder a format matcher would have blocked.
  const documentation = [
    'ANTHROPIC_API_KEY=sk-ant-your-api-key-goes-here',
    'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE',
    'SLACK_TOKEN=xoxb-your-token-here',
    'GITLAB_TOKEN=glpat-xxxxxxxxxxxxxxxxxxxx',
    'DATABASE_URL=postgres://postgres:postgres@localhost:54322/postgres',
    '-----BEGIN RSA PRIVATE KEY-----\\n...\\n-----END RSA PRIVATE KEY-----',
  ];

  // checkFile takes a path and nothing else: there is no content argument to pass.
  assert.deepStrictEqual(checkFile('docs/setup.md'), { allowed: true, path: 'docs/setup.md' });
  assert.deepStrictEqual(checkFile('README.md'), { allowed: true, path: 'README.md' });
  assert.strictEqual(documentation.every((text) => text.length > 0), true);
});

// The files credentials actually live in are still refused, by name, with no false
// positives. That is the whole argument for names-only.
test('the files credentials actually live in are still blocked', () => {
  for (const path of [
    '.env',
    'apps/web/.env.production',
    'certs/server.pem',
    'certs/server.key',
    'credentials.json',
    'gcp/my-service-account.json',
    '.npmrc',
    '.netrc',
    '.pgpass',
    '.git-credentials',
    'infra/prod.tfvars',
    'home/.ssh/id_rsa',
    '.aws/credentials',
  ]) {
    assert.strictEqual(isNameBlocked(path), true, `${path} must stay blocked`);
  }
});

test('the template exception is about names, so a .template is readable', () => {
  // It used to be refused when its contents looked key-shaped. With names-only a template
  // is a template — which is the point: showing the shape of a secret is documentation.
  assert.deepStrictEqual(checkFile('config/credentials.json.template'), {
    allowed: true,
    path: 'config/credentials.json.template',
  });
});

// ---------------------------------------------------------------------------
// 6. The combined verdict, in the order §6 requires
// ---------------------------------------------------------------------------

test('a name-blocked path is refused from the path alone', () => {
  // The answer cannot depend on the file existing, or on what is in it.
  assert.deepStrictEqual(checkFile('apps/web/.env.local'), { allowed: false, reason: 'name_blocked' });
  assert.deepStrictEqual(checkFile('apps/web/.env.local'), { allowed: false, reason: 'name_blocked' });
});

test('an invalid path is refused before anything else', () => {
  assert.deepStrictEqual(checkFile('../../.env'), { allowed: false, reason: 'invalid_path' });
});

test('an ordinary file passes and comes back normalised', () => {
  assert.deepStrictEqual(checkFile('./src//auth.ts'), { allowed: true, path: 'src/auth.ts' });
});

test('the refusal reply says nothing about whether the file exists', () => {
  assert.match(SENSITIVE_FILE_REPLY, /aren't available to me/);
  assert.ok(!/not found|exist/i.test(SENSITIVE_FILE_REPLY));
});

// ---------------------------------------------------------------------------
// 7. Listings
// ---------------------------------------------------------------------------

test('name-blocked entries are removed before counting or capping', () => {
  const entries = [
    { path: 'src/auth.ts' },
    { path: '.env' },
    { path: 'apps/web/.env.local' },
    { path: 'README.md' },
    { path: '.ssh/config' },
    { path: 'deploy/prod.env.example' },
  ];
  const visible = filterListing(entries, (e) => e.path);
  assert.deepStrictEqual(
    visible.map((e) => e.path),
    ['src/auth.ts', 'README.md', 'deploy/prod.env.example'],
    'blocked entries must not survive to be counted'
  );
});
