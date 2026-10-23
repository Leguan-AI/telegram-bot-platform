// Unit tests for the /repos command (#21 §3a, §9). Pure; no database, no network.
// Run: npx tsx --test scripts/test-repos-command.ts

import { test } from 'node:test';
import assert from 'assert';

import {
  buildContextRepoLine,
  buildRepoListing,
  buildReposHelp,
  buildUnknownReposReply,
  parseReposCommand,
  resolveRepoNames,
  type ScopedRepo,
} from '../lib/reposCommand';

const repo = (id: number, fullName: string, pinned = false): ScopedRepo => ({
  repoId: id,
  fullName,
  shortName: fullName.slice(fullName.indexOf('/') + 1),
  pinned,
});

const api = repo(1, 'SymmetricResearch/contributor-api');
const shannon = repo(2, 'SymmetricResearch/contributor-shannon');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a bare /repos is a view, with or without the bot suffix', () => {
  assert.deepStrictEqual(parseReposCommand('/repos'), { action: 'view' });
  assert.deepStrictEqual(parseReposCommand('/repos@leguan_the_bot'), { action: 'view' });
  assert.deepStrictEqual(parseReposCommand('  /repos   '), { action: 'view' });
});

test('pin and unpin take one or more names', () => {
  assert.deepStrictEqual(parseReposCommand('/repos pin api'), { action: 'pin', names: ['api'] });
  assert.deepStrictEqual(parseReposCommand('/repos pin api  shannon'), {
    action: 'pin',
    names: ['api', 'shannon'],
  });
  assert.deepStrictEqual(parseReposCommand('/repos@bot unpin api'), { action: 'unpin', names: ['api'] });
});

test('clear takes none, and casing does not matter', () => {
  assert.deepStrictEqual(parseReposCommand('/repos CLEAR'), { action: 'clear' });
  assert.deepStrictEqual(parseReposCommand('/REPOS Pin api'), { action: 'pin', names: ['api'] });
});

test('pin or unpin with no name asks which, rather than clearing everything', () => {
  assert.deepStrictEqual(parseReposCommand('/repos pin'), {
    action: 'help',
    reason: 'missing_names',
    subcommand: 'pin',
  });
  assert.deepStrictEqual(parseReposCommand('/repos unpin'), {
    action: 'help',
    reason: 'missing_names',
    subcommand: 'unpin',
  });
});

test('an unknown subcommand is not guessed at', () => {
  assert.deepStrictEqual(parseReposCommand('/repos remove api'), {
    action: 'help',
    reason: 'unknown_subcommand',
    subcommand: 'remove',
  });
});

// ---------------------------------------------------------------------------
// Name resolution — only ever against what is linked here
// ---------------------------------------------------------------------------

test('names resolve by short name or owner/name, case-insensitively', () => {
  const byShort = resolveRepoNames([api, shannon], ['contributor-api']);
  assert.deepStrictEqual(byShort.repos.map((r) => r.repoId), [1]);

  const byFull = resolveRepoNames([api, shannon], ['SymmetricResearch/contributor-shannon']);
  assert.deepStrictEqual(byFull.repos.map((r) => r.repoId), [2]);

  const mixedCase = resolveRepoNames([api, shannon], ['CONTRIBUTOR-API', '@contributor-shannon']);
  assert.deepStrictEqual(mixedCase.repos.map((r) => r.repoId), [1, 2]);
  assert.deepStrictEqual(mixedCase.unknown, []);
});

test('a name that is not linked here is reported, never silently dropped', () => {
  const resolved = resolveRepoNames([api], ['contributor-api', 'secret-repo']);
  assert.deepStrictEqual(resolved.repos.map((r) => r.repoId), [1]);
  assert.deepStrictEqual(resolved.unknown, ['secret-repo']);
});

test('repeating a name does not duplicate it', () => {
  const resolved = resolveRepoNames([api], ['contributor-api', 'contributor-api']);
  assert.deepStrictEqual(resolved.repos.map((r) => r.repoId), [1]);
});

test('the unknown-name reply lists the real choices', () => {
  const reply = buildUnknownReposReply(['nope'], [api, shannon]);
  assert.match(reply, /nope/);
  assert.match(reply, /contributor-api/);
  assert.match(reply, /contributor-shannon/);

  const noneLinked = buildUnknownReposReply(['nope'], []);
  assert.match(noneLinked, /no repositories are linked/i);
});

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

test('each connection state explains itself rather than showing an empty list', () => {
  const base = { repos: [], isPinned: false, inTopic: true };
  assert.match(buildRepoListing({ ...base, status: 'none' }), /No GitHub account is connected/);
  assert.match(buildRepoListing({ ...base, status: 'pending_confirmation' }), /waiting for a workspace admin/);
  assert.match(buildRepoListing({ ...base, status: 'suspended' }), /suspended/);
  assert.match(buildRepoListing({ ...base, status: 'active' }), /None linked here yet/);
});

test('an inheriting topic says so; a pinned one is marked', () => {
  const inheriting = buildRepoListing({
    status: 'active',
    repos: [api, shannon],
    isPinned: false,
    inTopic: true,
  });
  assert.match(inheriting, /not pinned/);
  assert.ok(!inheriting.includes('📌'), 'nothing should be marked pinned here');

  const pinned = buildRepoListing({
    status: 'active',
    repos: [repo(2, 'SymmetricResearch/contributor-shannon', true)],
    isPinned: true,
    inTopic: true,
  });
  assert.match(pinned, /📌/);
  assert.match(pinned, /pinned to the repositories above/);
});

test('outside a topic the listing does not talk about pins', () => {
  const listing = buildRepoListing({ status: 'active', repos: [api], isPinned: false, inTopic: false });
  assert.match(listing, /Available across this group/);
  assert.ok(!/pinned/i.test(listing));
});

test('when GitHub cannot be reached the ids are shown and said to be ids', () => {
  const listing = buildRepoListing({
    status: 'active',
    repos: [repo(7, '#7')],
    isPinned: false,
    inTopic: true,
    namesUnavailable: true,
  });
  assert.match(listing, /repository ids/);
});

test('repository names are HTML-escaped', () => {
  const nasty = repo(9, 'owner/<b>evil</b>');
  const listing = buildRepoListing({ status: 'active', repos: [nasty], isPinned: false, inTopic: true });
  assert.ok(!listing.includes('<b>evil</b>'), 'a repository name must not inject markup');
  assert.match(listing, /&lt;b&gt;evil/);
});

// ---------------------------------------------------------------------------
// The /context line
// ---------------------------------------------------------------------------

test('the /context line is one line, short names, pins marked', () => {
  const line = buildContextRepoLine({
    status: 'active',
    repos: [api, shannon],
    isPinned: false,
    inTopic: true,
  });
  assert.strictEqual(line.includes('\n'), false, 'it has to sit in the summary block');
  assert.match(line, /contributor-api/);
  assert.ok(!line.includes('SymmetricResearch/'), 'the owner is the same for every repo here');

  const pinned = buildContextRepoLine({
    status: 'active',
    repos: [repo(2, 'SymmetricResearch/contributor-shannon', true)],
    isPinned: true,
    inTopic: true,
  });
  assert.match(pinned, /📌/);
  assert.match(pinned, /pinned to this topic/);
});

test('the /context line names each unusable state', () => {
  const base = { repos: [], isPinned: false, inTopic: true };
  assert.match(buildContextRepoLine({ ...base, status: 'none' }), /not connected/);
  assert.match(buildContextRepoLine({ ...base, status: 'pending_confirmation' }), /awaiting admin/);
  assert.match(buildContextRepoLine({ ...base, status: 'suspended' }), /suspended/);
  assert.match(buildContextRepoLine({ ...base, status: 'active' }), /none linked here/);
});

test('help lists the subcommands', () => {
  const help = buildReposHelp({ action: 'help', reason: 'unknown_subcommand', subcommand: 'remove' });
  assert.match(help, /\/repos pin/);
  assert.match(help, /\/repos unpin/);
  assert.match(help, /\/repos clear/);
});
