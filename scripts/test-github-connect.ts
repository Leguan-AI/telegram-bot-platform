// Adversarial test suite for the GitHub App connect flow and repo-link schema (#21 §2, §3).
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-github-connect.ts
//
// WARNING: this harness inserts and deletes fixture rows in auth.users, public.entities,
// public.groups and public.threads (all UUID-scoped). Run it against a Supabase branch or
// staging database, NOT production: an interrupted run would leave fake auth users and
// entities behind. In production, verify with the /manage GitHub tab instead.
//
// OPERATOR-RUN ONLY. Per AGENTS.md rule 1 the database behind ADMIN_DATABASE_URL /
// DATABASE_URL is production unless you point it elsewhere: every row this script touches
// is a fixture UUID, every delete is scoped to those fixtures, and it performs no
// destructive DDL. It re-applies the (idempotent) connect migration as a convenience for
// repeat runs — the migration still reaches the remote ledger only through the operator's
// own `supabase db push` (AGENTS.md rules 7 and 8), which must happen BEFORE the first run
// of this script.
//
// Scope: everything decided inside Postgres — token lifecycle, the entity-from-token
// rule, one-installation-per-entity, confirm/reject/disconnect gating, the narrow-only
// pin trigger, the NULLS NOT DISTINCT constraint, cascades and RLS posture. The checks
// that happen at GitHub (forged installation_id, non-owner, mismatched account.id) are
// covered without a database or network by scripts/test-github-owner-check.ts, which runs
// in CI with the other pure unit tests.
//
// This harness stays out of CI, like every other script that needs a database URL. The
// remaining half of #22 — an `npm test` / `npm run test:db` split with a guardrail that
// refuses a database suite in CI unless it points at an ephemeral database — is still
// open; until it lands, this script is run by hand.

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Simulated authenticated Supabase user (same helper as test-group-linking.ts)
async function runAsUser<T>(
  sql: postgres.Sql,
  userId: string,
  email: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`set local role = 'authenticated'`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, email })}, true)`;
    await tx`set local row_security = on`;
    return await callback(tx);
  })) as T;
}

// ---------------------------------------------------------------------------
// Fixtures. All UUIDs are unique to this script.
// ---------------------------------------------------------------------------
const OWNER_A = 'fa000000-0000-0000-0000-0000000000a1'; // owner of E1
const ADMIN_A = 'fa000000-0000-0000-0000-0000000000a2'; // admin of E1
const VIEWER_A = 'fa000000-0000-0000-0000-0000000000a3'; // viewer of E1
const OWNER_B = 'fb000000-0000-0000-0000-0000000000b1'; // owner of E2
const STRANGER = 'fc000000-0000-0000-0000-0000000000c1';

const E1 = 'f1000000-0000-0000-0000-0000000000e1';
const E2 = 'f2000000-0000-0000-0000-0000000000e2';
const G1 = 'f1000000-0000-0000-0000-0000000000a1';
const G2 = 'f1000000-0000-0000-0000-0000000000a2';
const T1 = 'f1000000-0000-0000-0000-0000000000b1';
const T2 = 'f1000000-0000-0000-0000-0000000000b2';

const CHAT_1 = '9910001';
const CHAT_2 = '9910002';
const INSTALL_1 = '9911001';
const INSTALL_2 = '9911002';
const REPO_1 = '5551001';
const REPO_2 = '5551002';
const REPO_UNLINKED = '5559999';

const ALL_USERS = [OWNER_A, ADMIN_A, VIEWER_A, OWNER_B, STRANGER];

type GrantRow = {
  for_authenticated: boolean;
  for_anon: boolean;
  for_bot_service: boolean;
};

type CompleteResult = {
  entity_id: string;
  entity_name: string;
  kind: string;
  status: string;
  outcome: string;
  account_login: string;
  repository_selection: string;
};

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;
  let botSql: postgres.Sql | null = null;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required to run these tests.');
    }

    sql = postgres(adminUrl, { max: 10, prepare: false });
    botSql = postgres(botUrl, { max: 5, prepare: false });

    // Local helpers bound to the open connections
    const mint = async (user: string, email: string, entity: string, kind: string): Promise<string> =>
      runAsUser(sql!, user, email, async (tx) => {
        const res = await tx<{ mint_github_connect_token: string }[]>`
          select public.mint_github_connect_token(${entity}, ${kind})
        `;
        return res[0].mint_github_connect_token;
      });

    const complete = async (
      code: string,
      installationId: string,
      opts: {
        accountId?: string;
        accountLogin?: string;
        accountType?: string;
        selection?: string;
        githubUserId?: string;
        githubLogin?: string;
      } = {}
    ): Promise<CompleteResult> => {
      const rows = await botSql!<{ result: CompleteResult }[]>`
        select public.complete_github_connect(
          ${code},
          ${installationId},
          ${opts.accountId ?? '9001'},
          ${opts.accountLogin ?? 'acme'},
          ${opts.accountType ?? 'Organization'},
          ${opts.selection ?? 'selected'},
          ${opts.githubUserId ?? '7001'},
          ${opts.githubLogin ?? 'ownerdev'}
        ) as result
      `;
      return rows[0].result;
    };

    const expectRaise = async (expected: string, fn: () => Promise<unknown>, label: string) => {
      try {
        await fn();
      } catch (e: any) {
        assert.strictEqual(e.message, expected, `${label}: expected "${expected}", got "${e.message}"`);
        return;
      }
      assert.fail(`${label}: expected "${expected}" but the call succeeded`);
    };

    const expectCode = async (expected: string, fn: () => Promise<unknown>, label: string) => {
      try {
        await fn();
      } catch (e: any) {
        assert.strictEqual(e.code, expected, `${label}: expected SQLSTATE ${expected}, got ${e.code} (${e.message})`);
        return;
      }
      assert.fail(`${label}: expected SQLSTATE ${expected} but the call succeeded`);
    };

    const connection = async (entity: string) => {
      const rows = await sql!<any[]>`
        select * from public.github_installations where entity_id = ${entity}
      `;
      return rows[0] || null;
    };

    const insertLink = async (
      entity: string,
      installationRowId: string,
      groupId: string | null,
      threadId: string | null,
      repoId: string
    ) =>
      sql!`
        insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
        values (${entity}, ${installationRowId}, ${groupId}, ${threadId}, ${repoId})
      `;

    console.log('--- Applying Migration Schema (idempotent re-apply) ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20261022010000_github_app_connect.sql');
    await sql.unsafe(fs.readFileSync(migrationPath, 'utf8'));

    console.log('--- Setting Up Test Environment ---');
    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_A, 'gh_owner_a@test.com'],
      [ADMIN_A, 'gh_admin_a@test.com'],
      [VIEWER_A, 'gh_viewer_a@test.com'],
      [OWNER_B, 'gh_owner_b@test.com'],
      [STRANGER, 'gh_stranger@test.com'],
    ]) {
      await sql`
        insert into auth.users (id, email, email_confirmed_at, aud, role)
        values (${id}, ${email}, now(), 'authenticated', 'authenticated')
      `;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'gh-entity-1-test', 'GH Entity 1', ${OWNER_A}, 'gh_test_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'gh-entity-2-test', 'GH Entity 2', ${OWNER_B}, 'gh_test_bot_2')`;

    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${ADMIN_A}, 'admin', 'active', ${OWNER_A})`;
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${VIEWER_A}, 'viewer', 'active', ${OWNER_A})`;

    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G1}, ${E1}, ${CHAT_1}, 'GH Group 1')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G2}, ${E1}, ${CHAT_2}, 'GH Group 2')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id)
              values (${T1}, ${E1}, ${G1}, 7001)`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id)
              values (${T2}, ${E1}, ${G2}, 7002)`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test 1: minting is gated on entity admin rights
    // =========================================================================
    console.log('Test 1: mint gating...');
    await expectCode('42501', () => mint(VIEWER_A, 'gh_viewer_a@test.com', E1, 'direct'), 'Test 1 viewer');
    await expectCode('42501', () => mint(STRANGER, 'gh_stranger@test.com', E1, 'invite'), 'Test 1 stranger');
    await expectCode('42501', () => mint(OWNER_B, 'gh_owner_b@test.com', E1, 'direct'), 'Test 1 other-entity owner');
    await expectRaise('invalid_kind', () => mint(ADMIN_A, 'gh_admin_a@test.com', E1, 'sneaky'), 'Test 1 bad kind');

    const minted = await mint(ADMIN_A, 'gh_admin_a@test.com', E1, 'direct');
    assert.match(minted, /^[0-9A-HJKMNP-TV-Z]{26}$/, 'Test 1: unexpected token shape');
    const stored = await sql<{ token_hash: string; kind: string; expires_at: Date }[]>`
      select token_hash, kind, expires_at from public.github_connect_invites where entity_id = ${E1}
    `;
    assert.strictEqual(stored.length, 1, 'Test 1: expected exactly one minted token');
    assert.notStrictEqual(stored[0].token_hash, minted, 'Test 1: token must be stored hashed, never in clear');
    const hashed = await sql<{ h: string }[]>`select encode(sha256(${minted}::bytea), 'hex') as h`;
    assert.strictEqual(stored[0].token_hash, hashed[0].h, 'Test 1: stored hash does not match sha256(code)');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: direct connect (§2a) — active immediately, attributed to the admin
    // =========================================================================
    console.log('Test 2: direct connect...');
    const direct = await complete(minted, INSTALL_1);
    assert.strictEqual(direct.outcome, 'connected', 'Test 2: wrong outcome');
    assert.strictEqual(direct.status, 'active', 'Test 2: direct connect must be active immediately');
    assert.strictEqual(direct.entity_id, E1, 'Test 2: entity must come from the token');
    assert.strictEqual(direct.entity_name, 'GH Entity 1', 'Test 2: wrong entity name');

    const conn1 = await connection(E1);
    assert.ok(conn1, 'Test 2: no installation row written');
    assert.strictEqual(conn1.installation_id.toString(), INSTALL_1, 'Test 2: wrong installation id');
    assert.strictEqual(conn1.account_id.toString(), '9001', 'Test 2: wrong account id');
    assert.strictEqual(conn1.status, 'active');
    assert.strictEqual(conn1.connected_by_profile_id, ADMIN_A, 'Test 2: connecting /manage user not recorded');
    assert.strictEqual(conn1.connected_by_github_user_id.toString(), '7001', 'Test 2: GitHub user not recorded');
    assert.strictEqual(conn1.invited_by_profile_id, null, 'Test 2: direct connect has no inviter');
    assert.strictEqual(conn1.confirmed_at, null, 'Test 2: direct connect needs no confirmation');

    const consumed = await sql<any[]>`
      select consumed_at, completed_by_github_login, installation_id
      from public.github_connect_invites where entity_id = ${E1}
    `;
    assert.ok(consumed[0].consumed_at, 'Test 2: token not consumed');
    assert.strictEqual(consumed[0].completed_by_github_login, 'ownerdev', 'Test 2: completer not recorded');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: replay of a consumed token
    // =========================================================================
    console.log('Test 3: replayed token...');
    await expectRaise('already_consumed', () => complete(minted, INSTALL_1), 'Test 3');
    const count1 = await sql<{ c: string }[]>`select count(*)::text as c from public.github_installations where entity_id = ${E1}`;
    assert.strictEqual(count1[0].c, '1', 'Test 3: replay must not create a second row');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: one installation per entity (§2c)
    // =========================================================================
    console.log('Test 4: entity slot is taken...');
    const second = await mint(ADMIN_A, 'gh_admin_a@test.com', E1, 'direct');
    await expectRaise('entity_slot_taken', () => complete(second, INSTALL_2), 'Test 4');
    const stillOne = await connection(E1);
    assert.strictEqual(stillOne.installation_id.toString(), INSTALL_1, 'Test 4: existing connection was replaced');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: the same installation again = "already connected", status untouched
    // =========================================================================
    console.log('Test 5: already connected (repo selection changed)...');
    const again = await mint(ADMIN_A, 'gh_admin_a@test.com', E1, 'direct');
    const refreshed = await complete(again, INSTALL_1, { selection: 'all', accountLogin: 'acme-renamed' });
    assert.strictEqual(refreshed.outcome, 'already_connected', 'Test 5: wrong outcome');
    assert.strictEqual(refreshed.status, 'active', 'Test 5: status must be preserved');
    const conn5 = await connection(E1);
    assert.strictEqual(conn5.repository_selection, 'all', 'Test 5: repository_selection not refreshed');
    assert.strictEqual(conn5.account_login, 'acme-renamed', 'Test 5: account login not refreshed');
    assert.ok(conn5.updated_at > conn5.created_at, 'Test 5: updated_at not touched');
    await sql`update public.github_installations set repository_selection = 'selected', account_login = 'acme' where entity_id = ${E1}`;
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: cross-entity attach (§2c) — a second tenant cannot claim it
    // =========================================================================
    console.log('Test 6: cross-entity attach...');
    const crossToken = await mint(OWNER_B, 'gh_owner_b@test.com', E2, 'direct');
    await expectRaise('attached_elsewhere', () => complete(crossToken, INSTALL_1), 'Test 6');
    const conn6 = await connection(E1);
    assert.strictEqual(conn6.entity_id, E1, 'Test 6: installation was moved to another entity');
    assert.strictEqual(await connection(E2), null, 'Test 6: a row was written for the claiming entity');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: expiry
    // =========================================================================
    console.log('Test 7: expired token...');
    const expiring = await mint(OWNER_B, 'gh_owner_b@test.com', E2, 'invite');
    await sql`
      update public.github_connect_invites
      set expires_at = now() - interval '1 second'
      where token_hash = encode(sha256(${expiring}::bytea), 'hex')
    `;
    await expectRaise('expired', () => complete(expiring, INSTALL_2), 'Test 7 complete');
    await expectRaise('expired', () => botSql!`select public.peek_github_connect_invite(${expiring})`, 'Test 7 peek');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: revocation
    // =========================================================================
    console.log('Test 8: revoked invite...');
    const revokable = await mint(OWNER_B, 'gh_owner_b@test.com', E2, 'invite');
    const revokableId = (
      await sql<{ id: string }[]>`
        select id from public.github_connect_invites where token_hash = encode(sha256(${revokable}::bytea), 'hex')
      `
    )[0].id;

    await expectCode(
      '42501',
      () =>
        runAsUser(sql!, STRANGER, 'gh_stranger@test.com', (tx) =>
          tx`select public.revoke_github_connect_invite(${E2}, ${revokableId})`
        ),
      'Test 8 stranger revoke'
    );
    // Entity-scoped: an admin of another entity cannot revoke by guessing the id.
    await expectCode(
      '42501',
      () =>
        runAsUser(sql!, ADMIN_A, 'gh_admin_a@test.com', (tx) =>
          tx`select public.revoke_github_connect_invite(${E2}, ${revokableId})`
        ),
      'Test 8 cross-entity revoke'
    );
    await expectRaise(
      'invite_not_pending',
      () =>
        runAsUser(sql!, ADMIN_A, 'gh_admin_a@test.com', (tx) =>
          tx`select public.revoke_github_connect_invite(${E1}, ${revokableId})`
        ),
      'Test 8 wrong-entity revoke'
    );

    await runAsUser(sql, OWNER_B, 'gh_owner_b@test.com', (tx) =>
      tx`select public.revoke_github_connect_invite(${E2}, ${revokableId})`
    );
    await expectRaise('revoked', () => complete(revokable, INSTALL_2), 'Test 8 complete');
    await expectRaise('revoked', () => botSql!`select public.peek_github_connect_invite(${revokable})`, 'Test 8 peek');
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: a demoted issuer invalidates their pending invites
    // =========================================================================
    console.log('Test 9: issuer demoted...');
    const byAdminA = await mint(ADMIN_A, 'gh_admin_a@test.com', E1, 'invite');
    await sql`delete from public.authorizations where entity_id = ${E1} and profile_id = ${ADMIN_A}`;
    await expectRaise('issuer_not_admin', () => botSql!`select public.peek_github_connect_invite(${byAdminA})`, 'Test 9 peek');
    await expectRaise('issuer_not_admin', () => complete(byAdminA, INSTALL_2), 'Test 9 complete');
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${ADMIN_A}, 'admin', 'active', ${OWNER_A})`;
    console.log('✅ Test 9 Passed.');

    // =========================================================================
    // Test 10: connect invite (§2b) — lands as pending_confirmation
    // =========================================================================
    console.log('Test 10: connect invite...');
    const inviteCode = await mint(OWNER_B, 'gh_owner_b@test.com', E2, 'invite');

    const peeked = (
      await botSql<{ result: { entity_id: string; entity_name: string } }[]>`
        select public.peek_github_connect_invite(${inviteCode}) as result
      `
    )[0].result;
    assert.strictEqual(peeked.entity_id, E2, 'Test 10: landing page resolved the wrong entity');
    assert.strictEqual(peeked.entity_name, 'GH Entity 2', 'Test 10: wrong entity name');
    // Peeking must not consume the invite.
    const notConsumed = await sql<any[]>`
      select consumed_at from public.github_connect_invites where token_hash = encode(sha256(${inviteCode}::bytea), 'hex')
    `;
    assert.strictEqual(notConsumed[0].consumed_at, null, 'Test 10: the landing page consumed the invite');

    const invited = await complete(inviteCode, INSTALL_2, {
      accountId: '7700',
      accountLogin: 'devperson',
      accountType: 'User',
      githubUserId: '7700',
      githubLogin: 'devperson',
    });
    assert.strictEqual(invited.outcome, 'pending_confirmation', 'Test 10: wrong outcome');
    assert.strictEqual(invited.status, 'pending_confirmation', 'Test 10: invite must not be active');
    assert.strictEqual(invited.entity_id, E2, 'Test 10: entity must come from the invite, not the request');

    const conn10 = await connection(E2);
    assert.strictEqual(conn10.status, 'pending_confirmation');
    assert.strictEqual(conn10.invited_by_profile_id, OWNER_B, 'Test 10: issuing admin not recorded');
    assert.strictEqual(conn10.connected_by_github_login, 'devperson', 'Test 10: completer not recorded');
    assert.strictEqual(conn10.connected_by_profile_id, null, 'Test 10: an invite has no /manage connector');
    console.log('✅ Test 10 Passed.');

    // =========================================================================
    // Test 11: nothing can be linked to an unconfirmed connection
    // =========================================================================
    console.log('Test 11: linking against a pending connection...');
    await expectRaise(
      'repo_link_installation_not_active',
      () => insertLink(E2, conn10.id, null, null, REPO_1),
      'Test 11'
    );
    console.log('✅ Test 11 Passed.');

    // =========================================================================
    // Test 12: confirm / reject gating (§2b step 6)
    // =========================================================================
    console.log('Test 12: confirm and reject...');
    await expectCode(
      '42501',
      () => runAsUser(sql!, STRANGER, 'gh_stranger@test.com', (tx) => tx`select public.confirm_github_connection(${E2})`),
      'Test 12 stranger confirm'
    );
    await expectCode(
      '42501',
      () => runAsUser(sql!, ADMIN_A, 'gh_admin_a@test.com', (tx) => tx`select public.confirm_github_connection(${E2})`),
      'Test 12 cross-entity confirm'
    );
    await expectCode(
      '42501',
      () => runAsUser(sql!, STRANGER, 'gh_stranger@test.com', (tx) => tx`select public.reject_github_connection(${E2})`),
      'Test 12 stranger reject'
    );
    assert.strictEqual((await connection(E2)).status, 'pending_confirmation', 'Test 12: status changed under a refused call');

    // Reject frees the slot and leaves nothing behind.
    await runAsUser(sql, OWNER_B, 'gh_owner_b@test.com', (tx) => tx`select public.reject_github_connection(${E2})`);
    assert.strictEqual(await connection(E2), null, 'Test 12: rejected connection still present');
    const linksAfterReject = await sql<{ c: string }[]>`select count(*)::text as c from public.repo_links where entity_id = ${E2}`;
    assert.strictEqual(linksAfterReject[0].c, '0', 'Test 12: rejection left repo links behind');
    await expectRaise(
      'no_pending_connection',
      () => runAsUser(sql!, OWNER_B, 'gh_owner_b@test.com', (tx) => tx`select public.reject_github_connection(${E2})`),
      'Test 12 second reject'
    );

    // The freed slot takes a fresh connection, which an admin can then confirm.
    const inviteCode2 = await mint(OWNER_B, 'gh_owner_b@test.com', E2, 'invite');
    await complete(inviteCode2, INSTALL_2, {
      accountId: '7700',
      accountLogin: 'devperson',
      accountType: 'User',
      githubUserId: '7700',
      githubLogin: 'devperson',
    });
    await runAsUser(sql, OWNER_B, 'gh_owner_b@test.com', (tx) => tx`select public.confirm_github_connection(${E2})`);
    const conn12 = await connection(E2);
    assert.strictEqual(conn12.status, 'active', 'Test 12: confirmation did not activate the connection');
    assert.strictEqual(conn12.confirmed_by_profile_id, OWNER_B, 'Test 12: confirming admin not recorded');
    assert.ok(conn12.confirmed_at, 'Test 12: confirmed_at not set');
    await expectRaise(
      'no_pending_connection',
      () => runAsUser(sql!, OWNER_B, 'gh_owner_b@test.com', (tx) => tx`select public.confirm_github_connection(${E2})`),
      'Test 12 double confirm'
    );
    console.log('✅ Test 12 Passed.');

    // =========================================================================
    // Test 13: repo_links scoping, uniqueness and the narrow-only pin trigger
    // =========================================================================
    console.log('Test 13: repo link scoping and pin narrowing...');
    const inst1 = (await connection(E1)).id;

    await insertLink(E1, inst1, null, null, REPO_1);          // entity-level
    await insertLink(E1, inst1, G1, null, REPO_2);            // group-level

    // NULLS NOT DISTINCT: (entity, NULL, NULL, repo) cannot be duplicated.
    await expectCode('23505', () => insertLink(E1, inst1, null, null, REPO_1), 'Test 13 duplicate entity-level link');
    await expectCode('23505', () => insertLink(E1, inst1, G1, null, REPO_2), 'Test 13 duplicate group-level link');

    // Pins that narrow are allowed.
    await insertLink(E1, inst1, G1, T1, REPO_2);              // narrows the group link
    await insertLink(E1, inst1, G1, T1, REPO_1);              // narrows the entity-level link

    // Pins that would widen are refused.
    await expectRaise(
      'repo_pin_would_widen',
      () => insertLink(E1, inst1, G2, T2, REPO_2),
      'Test 13 pin in a group without that link'
    );
    await expectRaise(
      'repo_pin_would_widen',
      () => insertLink(E1, inst1, G1, T1, REPO_UNLINKED),
      'Test 13 pin of an unlinked repo'
    );
    // An update cannot smuggle a widening pin past the trigger either.
    await expectRaise(
      'repo_pin_would_widen',
      () => sql!`update public.repo_links set repo_id = ${REPO_UNLINKED} where entity_id = ${E1} and thread_id = ${T1} and repo_id = ${REPO_1}`,
      'Test 13 widening update'
    );
    // A pin always sits inside a group (shape constraint).
    await expectCode('23514', () => insertLink(E1, inst1, null, T1, REPO_1), 'Test 13 thread without group');
    console.log('✅ Test 13 Passed.');

    // =========================================================================
    // Test 14: unlinking a broader row takes its pins with it
    // =========================================================================
    console.log('Test 14: pins pruned when the broader link goes...');
    await sql`delete from public.repo_links where entity_id = ${E1} and group_id = ${G1} and thread_id is null and repo_id = ${REPO_2}`;
    const pinnedRepo2 = await sql<{ c: string }[]>`
      select count(*)::text as c from public.repo_links
      where entity_id = ${E1} and thread_id = ${T1} and repo_id = ${REPO_2}
    `;
    assert.strictEqual(pinnedRepo2[0].c, '0', 'Test 14: pin survived its group link');
    const pinnedRepo1 = await sql<{ c: string }[]>`
      select count(*)::text as c from public.repo_links
      where entity_id = ${E1} and thread_id = ${T1} and repo_id = ${REPO_1}
    `;
    assert.strictEqual(pinnedRepo1[0].c, '1', 'Test 14: pin backed by an entity-level link was pruned');
    console.log('✅ Test 14 Passed.');

    // =========================================================================
    // Test 15: cascades
    // =========================================================================
    console.log('Test 15: cascades...');
    await sql`delete from public.threads where id = ${T1}`;
    const afterThread = await sql<{ c: string }[]>`
      select count(*)::text as c from public.repo_links where entity_id = ${E1} and thread_id is not null
    `;
    assert.strictEqual(afterThread[0].c, '0', 'Test 15: pins survived their thread');

    await insertLink(E1, inst1, G2, null, REPO_2);
    await sql`delete from public.groups where id = ${G2}`;
    const afterGroup = await sql<{ c: string }[]>`
      select count(*)::text as c from public.repo_links where entity_id = ${E1} and group_id is not null
    `;
    assert.strictEqual(afterGroup[0].c, '0', 'Test 15: group links survived their group');

    // Disconnect: gated, and it takes the links with it.
    await expectCode(
      '42501',
      () =>
        runAsUser(sql!, VIEWER_A, 'gh_viewer_a@test.com', (tx) =>
          tx`select public.disconnect_github_connection(${E1})`
        ),
      'Test 15 viewer disconnect'
    );
    await runAsUser(sql, ADMIN_A, 'gh_admin_a@test.com', (tx) => tx`select public.disconnect_github_connection(${E1})`);
    assert.strictEqual(await connection(E1), null, 'Test 15: disconnect left the installation behind');
    const afterDisconnect = await sql<{ c: string }[]>`
      select count(*)::text as c from public.repo_links where entity_id = ${E1}
    `;
    assert.strictEqual(afterDisconnect[0].c, '0', 'Test 15: disconnect left repo links behind');
    await expectRaise(
      'no_connection',
      () => runAsUser(sql!, ADMIN_A, 'gh_admin_a@test.com', (tx) => tx`select public.disconnect_github_connection(${E1})`),
      'Test 15 second disconnect'
    );
    console.log('✅ Test 15 Passed.');

    // =========================================================================
    // Test 16: RLS posture and privilege isolation
    // =========================================================================
    console.log('Test 16: RLS and privileges...');
    const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class
      where relnamespace = 'public'::regnamespace
        and relname in ('github_installations', 'repo_links', 'github_connect_invites')
    `;
    assert.strictEqual(rls.length, 3, 'Test 16: a table is missing');
    for (const row of rls) {
      assert.ok(row.relrowsecurity, `Test 16: RLS not enabled on ${row.relname}`);
      assert.ok(row.relforcerowsecurity, `Test 16: RLS not forced on ${row.relname}`);
    }

    // bot_service sees only the entity in its transaction-local context.
    const visible = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E2}, true)`;
      const own = await tx<{ c: string }[]>`select count(*)::text as c from public.github_installations`;
      return own[0].c;
    });
    assert.strictEqual(visible, '1', 'Test 16: bot_service cannot see its own entity row');

    const leaked = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      const rows = await tx<{ c: string }[]>`
        select count(*)::text as c from public.github_installations where entity_id = ${E2}
      `;
      return rows[0].c;
    });
    assert.strictEqual(leaked, '0', 'Test 16: cross-tenant installation row is visible to bot_service');

    const contextless = await botSql<{ c: string }[]>`select count(*)::text as c from public.github_installations`;
    assert.strictEqual(contextless[0].c, '0', 'Test 16: rows visible without an entity context');

    // Connect tokens are management-plane: bot_service reaches them only through the
    // SECURITY DEFINER functions.
    await expectCode(
      '42501',
      () => botSql!`select count(*) from public.github_connect_invites`,
      'Test 16 bot_service reading invites'
    );

    // Who may call what. Each row carries its own expectation:
    //   'bot'  — the callback path, bot_service only;
    //   'auth' — the /manage path, authenticated only;
    //   'none' — internal helper, callable by no role at all.
    const fnExpectations: Array<{ name: string; signature: string; audience: 'bot' | 'auth' | 'none' }> = [
      {
        name: 'complete_github_connect',
        signature: 'public.complete_github_connect(text,bigint,bigint,text,text,text,bigint,text)',
        audience: 'bot',
      },
      { name: 'peek_github_connect_invite', signature: 'public.peek_github_connect_invite(text)', audience: 'bot' },
      { name: 'mint_github_connect_token', signature: 'public.mint_github_connect_token(uuid,text)', audience: 'auth' },
      { name: 'confirm_github_connection', signature: 'public.confirm_github_connection(uuid)', audience: 'auth' },
      { name: 'reject_github_connection', signature: 'public.reject_github_connection(uuid)', audience: 'auth' },
      { name: 'disconnect_github_connection', signature: 'public.disconnect_github_connection(uuid)', audience: 'auth' },
      { name: 'get_github_connection', signature: 'public.get_github_connection(uuid)', audience: 'auth' },
      { name: 'is_entity_admin_profile', signature: 'public.is_entity_admin_profile(uuid,uuid)', audience: 'none' },
    ];

    for (const fn of fnExpectations) {
      const granted: GrantRow[] = await sql<GrantRow[]>`
        select
          has_function_privilege('authenticated'::name, ${fn.signature}::text, 'execute') as for_authenticated,
          has_function_privilege('anon'::name, ${fn.signature}::text, 'execute') as for_anon,
          has_function_privilege('bot_service'::name, ${fn.signature}::text, 'execute') as for_bot_service
      `;
      assert.strictEqual(granted[0].for_anon, false, `Test 16: ${fn.name} is executable by anon`);
      assert.strictEqual(
        granted[0].for_authenticated,
        fn.audience === 'auth',
        `Test 16: unexpected authenticated privilege on ${fn.name}`
      );
      assert.strictEqual(
        granted[0].for_bot_service,
        fn.audience === 'bot',
        `Test 16: unexpected bot_service privilege on ${fn.name}`
      );
    }
    console.log('✅ Test 16 Passed.');

    // =========================================================================
    // Test 17: deleting an entity takes its GitHub state with it
    // =========================================================================
    console.log('Test 17: entity cascade...');
    await sql`delete from public.entities where id = ${E2}`;
    const leftovers = await sql<{ installs: string; invites: string; links: string }[]>`
      select
        (select count(*)::text from public.github_installations where entity_id = ${E2}) as installs,
        (select count(*)::text from public.github_connect_invites where entity_id = ${E2}) as invites,
        (select count(*)::text from public.repo_links where entity_id = ${E2}) as links
    `;
    assert.strictEqual(leftovers[0].installs, '0', 'Test 17: installation survived its entity');
    assert.strictEqual(leftovers[0].invites, '0', 'Test 17: invites survived their entity');
    assert.strictEqual(leftovers[0].links, '0', 'Test 17: repo links survived their entity');
    console.log('✅ Test 17 Passed.');

    console.log('\n🎉 ALL GITHUB CONNECT TESTS PASSED SUCCESSFULLY! 🎉');
  } catch (error) {
    console.error('\n❌ Verification Failed:');
    console.error(error);
    process.exit(1);
  } finally {
    console.log('\n--- Cleaning Up Test Environment ---');
    if (sql) {
      try {
        await cleanup(sql);
        await sql.end();
      } catch (e) {
        console.warn('Cleanup failed:', e);
      }
    }
    if (botSql) {
      try {
        await botSql.end();
      } catch (e) {
        console.warn('Bot sql close failed:', e);
      }
    }
  }
}

/** Fixture-scoped teardown (AGENTS.md rule 4): never an unscoped delete. */
async function cleanup(sql: postgres.Sql) {
  await sql`delete from public.repo_links where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.github_connect_invites where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.github_installations where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.threads where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.authorizations where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.entities where id in (${E1}, ${E2})`;
  await sql`delete from auth.users where id in ${sql(ALL_USERS)}`;
}

main();
