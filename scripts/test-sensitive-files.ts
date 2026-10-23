// Unit tests for the sensitive-file policy (#21 §6). Pure; no database, no network.
// Run: npx tsx --test scripts/test-sensitive-files.ts
//
// The vectors in "the table from §6" are the issue's own worked examples, reproduced
// exactly. If one of them ever has to change, the issue changes first.

import { test } from 'node:test';
import assert from 'assert';

import {
  checkFile,
  contentRuleNames,
  filterListing,
  findContentSecret,
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

test('malformed escapes are refused rather than guessed at', () => {
  assert.deepStrictEqual(normalizeRepoPath('src/%zz'), { ok: false, reason: 'invalid_path' });
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
// 5. Content rules
// ---------------------------------------------------------------------------

test('every content rule matches a representative sample', () => {
  const samples: Array<[string, string]> = [
    ['private-key-block', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...'],
    ['private-key-block', '-----BEGIN PRIVATE KEY-----'],
    ['gcp-service-account', '{\n  "type": "service_account",\n  "project_id": "x"\n}'],
    ['aws-access-key', 'AKIAIOSFODNN7EXAMPLE'],
    ['aws-access-key', 'ASIAIOSFODNN7EXAMPLE'],
    ['github-token', `ghp_${'a'.repeat(36)}`],
    ['github-token', `ghs_${'b'.repeat(36)}`],
    ['github-pat', `github_pat_${'c'.repeat(30)}`],
    ['google-api-key', `AIza${'d'.repeat(35)}`],
    ['stripe-live-key', `sk_live_${'e'.repeat(24)}`],
    ['stripe-live-key', `rk_live_${'f'.repeat(24)}`],
    ['anthropic-key', `sk-ant-${'g'.repeat(24)}`],
    ['openai-project-key', `sk-proj-${'h'.repeat(24)}`],
    ['openai-legacy-key', `sk-${'i'.repeat(40)}`],
    ['slack-token', `xoxb-${'1'.repeat(20)}`],
  ];

  for (const [rule, sample] of samples) {
    assert.strictEqual(findContentSecret(sample), rule, `expected ${rule} for ${sample.slice(0, 24)}…`);
  }
});

test('every documented rule is covered by the samples above', () => {
  const covered = new Set([
    'private-key-block',
    'gcp-service-account',
    'aws-access-key',
    'github-token',
    'github-pat',
    'google-api-key',
    'stripe-live-key',
    'anthropic-key',
    'openai-project-key',
    'openai-legacy-key',
    'slack-token',
  ]);
  for (const name of contentRuleNames()) {
    assert.ok(covered.has(name), `content rule ${name} has no test sample`);
  }
});

// The explicit non-matches from #21: ordinary text must not trip the token patterns.
test('ordinary text does not trip the content rules', () => {
  for (const text of [
    'scikit-learn==1.4.0',
    'sk-learn is not a key',
    'install scikit-learn and sk-video',
    'const x = "a-very-long-hyphenated-identifier-that-goes-on"',
    'AKIA is a prefix but not followed by a key',
    'sk-short',
    'xoxb-tooshort',
    'see https://example.com/docs/private-key-handling',
    'type: service_account_like_but_not',
  ]) {
    assert.strictEqual(findContentSecret(text), null, `should not match: ${text}`);
  }
});

test('a template file containing a real key is still content-blocked', () => {
  const verdict = checkFile('config/credentials.json.template', '-----BEGIN PRIVATE KEY-----\nabc');
  assert.deepStrictEqual(verdict, { allowed: false, reason: 'content_blocked', rule: 'private-key-block' });
});

// ---------------------------------------------------------------------------
// 6. The combined verdict, in the order §6 requires
// ---------------------------------------------------------------------------

test('a name-blocked path is refused before contents are considered', () => {
  // Same verdict with or without content: the answer cannot depend on the file existing.
  assert.deepStrictEqual(checkFile('apps/web/.env.local'), { allowed: false, reason: 'name_blocked' });
  assert.deepStrictEqual(checkFile('apps/web/.env.local', 'PORT=3000'), {
    allowed: false,
    reason: 'name_blocked',
  });
});

test('an invalid path is refused before anything else', () => {
  assert.deepStrictEqual(checkFile('../../.env'), { allowed: false, reason: 'invalid_path' });
});

test('an ordinary file passes and comes back normalised', () => {
  assert.deepStrictEqual(checkFile('./src//auth.ts', 'export const x = 1;'), {
    allowed: true,
    path: 'src/auth.ts',
  });
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
