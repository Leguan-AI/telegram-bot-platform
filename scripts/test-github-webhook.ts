// Unit tests for the GitHub webhook signature check and event interpretation (#21 §4).
// Pure; no database access, no network.
// Run: npx tsx --test scripts/test-github-webhook.ts

import { test } from 'node:test';
import assert from 'assert';
import { createHmac } from 'node:crypto';

import { interpretWebhook, isValidGitHubSignature } from '../lib/githubWebhook';

const SECRET = 'a-webhook-secret';

function sign(body: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test('a correctly signed body is accepted', () => {
  const body = '{"action":"deleted"}';
  assert.strictEqual(isValidGitHubSignature(SECRET, body, sign(body)), true);
});

test('a tampered body is rejected', () => {
  const body = '{"action":"deleted"}';
  const signature = sign(body);
  assert.strictEqual(isValidGitHubSignature(SECRET, '{"action":"suspend"}', signature), false);
});

test('a signature from a different secret is rejected', () => {
  const body = '{"action":"deleted"}';
  assert.strictEqual(isValidGitHubSignature(SECRET, body, sign(body, 'another-secret')), false);
});

test('a missing secret or header never matches', () => {
  const body = '{}';
  assert.strictEqual(isValidGitHubSignature(undefined, body, sign(body)), false);
  assert.strictEqual(isValidGitHubSignature('', body, sign(body)), false);
  assert.strictEqual(isValidGitHubSignature(SECRET, body, null), false);
  assert.strictEqual(isValidGitHubSignature(SECRET, body, ''), false);
});

test('the sha256= prefix is part of what is compared', () => {
  const body = '{}';
  const bare = sign(body).slice('sha256='.length);
  assert.strictEqual(isValidGitHubSignature(SECRET, body, bare), false);
  assert.strictEqual(isValidGitHubSignature(SECRET, body, `sha1=${bare}`), false);
});

// This is why the route must not parse-then-restringify: re-serialising changes the bytes
// and the HMAC no longer matches.
test('a re-serialised body does not verify against the raw signature', () => {
  const raw = '{"action":"deleted",  "installation": {"id": 42}}';
  const signature = sign(raw);
  const reserialised = JSON.stringify(JSON.parse(raw));

  assert.strictEqual(isValidGitHubSignature(SECRET, raw, signature), true);
  assert.strictEqual(isValidGitHubSignature(SECRET, reserialised, signature), false);
});

test('multibyte bodies are signed over their utf-8 bytes', () => {
  const body = JSON.stringify({ action: 'deleted', note: 'héllo — wörld 🙂' });
  assert.strictEqual(isValidGitHubSignature(SECRET, body, sign(body)), true);
});

// ---------------------------------------------------------------------------
// Event interpretation
// ---------------------------------------------------------------------------

const installation = { id: 4242, repository_selection: 'selected' };

test('installation.deleted clears the connection', () => {
  const result = interpretWebhook('installation', { action: 'deleted', installation });
  assert.strictEqual(result.installationId, 4242);
  assert.deepStrictEqual(result.action, { kind: 'delete_installation' });
});

test('installation.suspend and unsuspend map to the status change', () => {
  assert.deepStrictEqual(
    interpretWebhook('installation', { action: 'suspend', installation }).action,
    { kind: 'set_suspended', suspended: true }
  );
  assert.deepStrictEqual(
    interpretWebhook('installation', { action: 'unsuspend', installation }).action,
    { kind: 'set_suspended', suspended: false }
  );
});

test('installation.created is ignored but still refreshes the selection', () => {
  const result = interpretWebhook('installation', {
    action: 'created',
    installation: { id: 4242, repository_selection: 'all' },
  });
  assert.strictEqual(result.action.kind, 'ignore');
  assert.strictEqual(result.repositorySelection, 'all');
});

test('installation_repositories.removed lists the repository ids', () => {
  const result = interpretWebhook('installation_repositories', {
    action: 'removed',
    installation,
    repositories_removed: [{ id: 7 }, { id: 9 }],
  });
  assert.deepStrictEqual(result.action, { kind: 'remove_repositories', repoIds: [7, 9] });
});

test('removed ids are de-duplicated and non-numeric ones dropped', () => {
  const result = interpretWebhook('installation_repositories', {
    action: 'removed',
    installation,
    repositories_removed: [{ id: 7 }, { id: 7 }, { id: 'nope' }, { id: -1 }, {}],
  });
  assert.deepStrictEqual(result.action, { kind: 'remove_repositories', repoIds: [7] });
});

// `added` needs no action: links are explicit, so a newly shared repository simply becomes
// available to link.
test('installation_repositories.added is ignored', () => {
  const result = interpretWebhook('installation_repositories', {
    action: 'added',
    installation,
    repositories_added: [{ id: 11 }],
  });
  assert.strictEqual(result.action.kind, 'ignore');
});

test('unknown events and actions are ignored, not guessed at', () => {
  assert.strictEqual(interpretWebhook('ping', { zen: '…', installation }).action.kind, 'ignore');
  assert.strictEqual(interpretWebhook('push', { installation }).action.kind, 'ignore');
  assert.strictEqual(
    interpretWebhook('installation', { action: 'new_permissions_accepted', installation }).action.kind,
    'ignore'
  );
});

test('a payload with no usable installation id yields null', () => {
  assert.strictEqual(interpretWebhook('installation', { action: 'deleted' }).installationId, null);
  assert.strictEqual(
    interpretWebhook('installation', { action: 'deleted', installation: { id: 'abc' } }).installationId,
    null
  );
  assert.strictEqual(interpretWebhook('installation', null).installationId, null);
});

test('an unexpected repository_selection is not passed through', () => {
  const result = interpretWebhook('installation', {
    action: 'created',
    installation: { id: 4242, repository_selection: 'everything' },
  });
  assert.strictEqual(result.repositorySelection, null);
});
