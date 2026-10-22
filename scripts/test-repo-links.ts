// Adversarial test suite for repository linking (#21 §3, §3a DB side).
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-repo-links.ts
//
// WARNING: this harness inserts and deletes fixture rows in auth.users, public.entities,
// public.groups and public.threads (all UUID-scoped). Run it against a Supabase branch or
// staging database, NOT production: an interrupted run would leave fake auth users and
// entities behind. In production, verify with the /manage GitHub tab instead.
//
// OPERATOR-RUN ONLY, and it never pushes a migration: 20261022020000 must already be
// applied by the operator (AGENTS.md rules 7 and 8). It re-applies that migration's raw,
// idempotent DDL only so repeat runs pick up local edits.
//
// Scope: what the database decides — who may save links, where a link may point, and the
// invariants no route can be trusted with. The GitHub-side half of the save (that every
// submitted repository id is still in the installation) lives in the route and is covered
// by scripts/test-github-app-token.ts plus the route's own re-check.

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

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

// Fixtures, distinct from every other harness in scripts/.
const OWNER_A = 'da000000-0000-0000-0000-0000000000a1';
const ADMIN_A = 'da000000-0000-0000-0000-0000000000a2';
const VIEWER_A = 'da000000-0000-0000-0000-0000000000a3';
const OWNER_B = 'db000000-0000-0000-0000-0000000000b1';
const ALL_USERS = [OWNER_A, ADMIN_A, VIEWER_A, OWNER_B];

const E1 = 'd1000000-0000-0000-0000-0000000000e1';
const E2 = 'd2000000-0000-0000-0000-0000000000e2';
const G1 = 'd1000000-0000-0000-0000-0000000000a1';
const G2 = 'd1000000-0000-0000-0000-0000000000a2';
const GB = 'd2000000-0000-0000-0000-0000000000b1';
const T1 = 'd1000000-0000-0000-0000-0000000000b1';
const T2 = 'd1000000-0000-0000-0000-0000000000b2';

const CHAT_1 = '9920001';
const CHAT_2 = '9920002';
const CHAT_B = '9920003';
const INSTALL_A = '9921001';
const INSTALL_B = '9921002';
const REPO_1 = '5552001';
const REPO_2 = '5552002';
const REPO_3 = '5552003';

type SaveResult = { added: number; removed: number; total: number };

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

    const save = async (
      entity: string,
      profile: string | null,
      group: string | null,
      thread: string | null,
      repoIds: string[]
    ): Promise<SaveResult> => {
      const csv = repoIds.join(',');
      const rows = await botSql!<{ result: SaveResult }[]>`
        select public.set_repo_links(
          ${entity},
          ${profile},
          ${group},
          ${thread},
          string_to_array(nullif(${csv}, ''), ',')::bigint[]
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

    const linksAt = async (entity: string, group: string | null, thread: string | null) => {
      const rows = await sql!<{ repo_id: string; linked_by_profile_id: string | null }[]>`
        select repo_id::text, linked_by_profile_id
        from public.repo_links
        where entity_id = ${entity}
          and group_id is not distinct from ${group}
          and thread_id is not distinct from ${thread}
        order by repo_id
      `;
      return rows;
    };

    console.log('--- Applying Migration Schema (idempotent re-apply) ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20261022020000_repo_link_management.sql');
    await sql.unsafe(fs.readFileSync(migrationPath, 'utf8'));

    console.log('--- Setting Up Test Environment ---');
    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_A, 'rl_owner_a@test.com'],
      [ADMIN_A, 'rl_admin_a@test.com'],
      [VIEWER_A, 'rl_viewer_a@test.com'],
      [OWNER_B, 'rl_owner_b@test.com'],
    ]) {
      await sql`
        insert into auth.users (id, email, email_confirmed_at, aud, role)
        values (${id}, ${email}, now(), 'authenticated', 'authenticated')
      `;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'rl-entity-1-test', 'RL Entity 1', ${OWNER_A}, 'rl_test_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'rl-entity-2-test', 'RL Entity 2', ${OWNER_B}, 'rl_test_bot_2')`;

    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${ADMIN_A}, 'admin', 'active', ${OWNER_A})`;
    await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
              values (${E1}, ${VIEWER_A}, 'viewer', 'active', ${OWNER_A})`;

    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G1}, ${E1}, ${CHAT_1}, 'RL Group 1')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G2}, ${E1}, ${CHAT_2}, 'RL Group 2')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${GB}, ${E2}, ${CHAT_B}, 'RL Group B')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
              values (${T1}, ${E1}, ${G1}, 7101, 'Mobile')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
              values (${T2}, ${E1}, ${G2}, 7102, 'Backend')`;

    // E1 has an active connection; E2's is still awaiting confirmation.
    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E1}, ${INSTALL_A}, 9101, 'rl-acme', 'Organization', 'selected', 'active')`;
    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E2}, ${INSTALL_B}, 9102, 'rl-other', 'Organization', 'selected', 'pending_confirmation')`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test 1: only an entity admin may save, and the profile is never assumed
    // =========================================================================
    console.log('Test 1: save gating...');
    await expectCode('42501', () => save(E1, VIEWER_A, null, null, [REPO_1]), 'Test 1 viewer');
    await expectCode('42501', () => save(E1, OWNER_B, null, null, [REPO_1]), 'Test 1 other-entity owner');
    await expectCode('42501', () => save(E1, null, null, null, [REPO_1]), 'Test 1 null profile');
    assert.strictEqual((await linksAt(E1, null, null)).length, 0, 'Test 1: a refused save wrote rows');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: nothing can be linked without an active connection
    // =========================================================================
    console.log('Test 2: inactive connection...');
    await expectRaise('no_active_installation', () => save(E2, OWNER_B, null, null, [REPO_1]), 'Test 2 pending');
    await sql`update public.github_installations set status = 'suspended' where entity_id = ${E1}`;
    await expectRaise('no_active_installation', () => save(E1, OWNER_A, null, null, [REPO_1]), 'Test 2 suspended');
    await sql`update public.github_installations set status = 'active' where entity_id = ${E1}`;
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: entity-level save, replace semantics, and the linker recorded
    // =========================================================================
    console.log('Test 3: entity-level save...');
    const first = await save(E1, ADMIN_A, null, null, [REPO_1, REPO_2]);
    assert.deepStrictEqual(first, { added: 2, removed: 0, total: 2 }, 'Test 3: wrong counts on first save');

    const rows = await linksAt(E1, null, null);
    assert.deepStrictEqual(rows.map((r) => r.repo_id), [REPO_1, REPO_2], 'Test 3: wrong links');
    assert.ok(
      rows.every((r) => r.linked_by_profile_id === ADMIN_A),
      'Test 3: the linking /manage user was not recorded'
    );

    // A repeated save is a no-op, not a duplicate: the NULLS NOT DISTINCT index is the
    // conflict target.
    const repeat = await save(E1, ADMIN_A, null, null, [REPO_1, REPO_2]);
    assert.deepStrictEqual(repeat, { added: 0, removed: 0, total: 2 }, 'Test 3: repeat was not a no-op');

    // Saving a smaller set removes the rest.
    const shrunk = await save(E1, ADMIN_A, null, null, [REPO_2]);
    assert.deepStrictEqual(shrunk, { added: 0, removed: 1, total: 1 }, 'Test 3: shrink counts wrong');
    assert.deepStrictEqual((await linksAt(E1, null, null)).map((r) => r.repo_id), [REPO_2]);

    // An empty selection clears the scope rather than meaning "everything".
    const cleared = await save(E1, ADMIN_A, null, null, []);
    assert.deepStrictEqual(cleared, { added: 0, removed: 1, total: 0 }, 'Test 3: clear counts wrong');
    assert.strictEqual((await linksAt(E1, null, null)).length, 0, 'Test 3: clearing left rows');
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: scopes are independent
    // =========================================================================
    console.log('Test 4: scope independence...');
    await save(E1, ADMIN_A, null, null, [REPO_1]);
    await save(E1, ADMIN_A, G1, null, [REPO_2]);
    await save(E1, ADMIN_A, G2, null, [REPO_3]);

    assert.deepStrictEqual((await linksAt(E1, null, null)).map((r) => r.repo_id), [REPO_1]);
    assert.deepStrictEqual((await linksAt(E1, G1, null)).map((r) => r.repo_id), [REPO_2]);
    assert.deepStrictEqual((await linksAt(E1, G2, null)).map((r) => r.repo_id), [REPO_3]);

    // Saving one group does not disturb the other, nor the entity level.
    await save(E1, ADMIN_A, G1, null, [REPO_2, REPO_3]);
    assert.deepStrictEqual((await linksAt(E1, null, null)).map((r) => r.repo_id), [REPO_1]);
    assert.deepStrictEqual((await linksAt(E1, G2, null)).map((r) => r.repo_id), [REPO_3]);
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: topic pins narrow only
    // =========================================================================
    console.log('Test 5: topic pins...');
    // REPO_2 is linked to G1, so T1 (a topic of G1) may pin it.
    const pinned = await save(E1, ADMIN_A, G1, T1, [REPO_2]);
    assert.deepStrictEqual(pinned, { added: 1, removed: 0, total: 1 }, 'Test 5: pin counts wrong');

    // REPO_1 is entity-level, which is broader than the group, so pinning it is narrowing.
    await save(E1, ADMIN_A, G1, T1, [REPO_2, REPO_1]);
    assert.deepStrictEqual((await linksAt(E1, G1, T1)).map((r) => r.repo_id), [REPO_1, REPO_2]);

    // A repo linked to the *other* group is not in scope for this topic.
    await expectRaise(
      'repo_pin_would_widen',
      () => save(E1, ADMIN_A, G2, T2, [REPO_2]),
      'Test 5 pin outside the group'
    );
    // Nor is one that is not linked anywhere.
    await expectRaise(
      'repo_pin_would_widen',
      () => save(E1, ADMIN_A, G1, T1, [REPO_2, '5559999']),
      'Test 5 pin of an unlinked repo'
    );
    // A thread always needs its group.
    await expectRaise('thread_without_group', () => save(E1, ADMIN_A, null, T1, [REPO_1]), 'Test 5 thread alone');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: a link cannot point at another tenant's group, or a foreign thread
    // =========================================================================
    console.log('Test 6: foreign scope...');
    await expectRaise(
      'repo_link_group_foreign',
      () => save(E1, ADMIN_A, GB, null, [REPO_1]),
      'Test 6 group from another entity'
    );
    // T2 belongs to G2, not G1.
    await expectRaise(
      'repo_link_thread_foreign',
      () => save(E1, ADMIN_A, G1, T2, [REPO_1]),
      'Test 6 thread from another group'
    );
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: unlinking a broader repo takes its pins with it
    // =========================================================================
    console.log('Test 7: pins pruned on unlink...');
    assert.deepStrictEqual((await linksAt(E1, G1, T1)).map((r) => r.repo_id), [REPO_1, REPO_2]);
    // Drop REPO_2 from G1; the T1 pin for REPO_2 must go, the REPO_1 pin must stay (it is
    // still linked at entity level).
    await save(E1, ADMIN_A, G1, null, [REPO_3]);
    assert.deepStrictEqual(
      (await linksAt(E1, G1, T1)).map((r) => r.repo_id),
      [REPO_1],
      'Test 7: the widowed pin was not pruned'
    );
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: list_repo_links — gating and the names the browser cannot read
    // =========================================================================
    console.log('Test 8: list_repo_links...');
    await expectCode(
      '42501',
      () => runAsUser(sql!, VIEWER_A, 'rl_viewer_a@test.com', (tx) => tx`select * from public.list_repo_links(${E1})`),
      'Test 8 viewer list'
    );
    await expectCode(
      '42501',
      () => runAsUser(sql!, OWNER_B, 'rl_owner_b@test.com', (tx) => tx`select * from public.list_repo_links(${E1})`),
      'Test 8 cross-entity list'
    );

    const listed = await runAsUser(sql, ADMIN_A, 'rl_admin_a@test.com', (tx) =>
      tx<any[]>`select * from public.list_repo_links(${E1})`
    );
    const pin = listed.find((l) => l.thread_id === T1);
    assert.ok(pin, 'Test 8: the pin is missing from the list');
    assert.strictEqual(pin.group_name, 'RL Group 1', 'Test 8: group name not resolved');
    assert.strictEqual(pin.thread_name, 'Mobile', 'Test 8: topic name not resolved');
    assert.strictEqual(pin.telegram_chat_id.toString(), CHAT_1, 'Test 8: chat id not resolved');
    const entityLevel = listed.find((l) => l.group_id === null);
    assert.ok(entityLevel, 'Test 8: the entity-level link is missing');
    assert.strictEqual(entityLevel.group_name, null, 'Test 8: entity-level link has a group name');
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: who may call what
    // =========================================================================
    console.log('Test 9: privileges...');
    const expectations: Array<{ name: string; signature: string; audience: 'bot' | 'auth' }> = [
      { name: 'set_repo_links', signature: 'public.set_repo_links(uuid,uuid,uuid,uuid,bigint[])', audience: 'bot' },
      {
        name: 'get_github_connection_for_admin',
        signature: 'public.get_github_connection_for_admin(uuid,uuid)',
        audience: 'bot',
      },
      { name: 'list_repo_links', signature: 'public.list_repo_links(uuid)', audience: 'auth' },
    ];

    for (const fn of expectations) {
      const granted: GrantRow[] = await sql<GrantRow[]>`
        select
          has_function_privilege('authenticated'::name, ${fn.signature}::text, 'execute') as for_authenticated,
          has_function_privilege('anon'::name, ${fn.signature}::text, 'execute') as for_anon,
          has_function_privilege('bot_service'::name, ${fn.signature}::text, 'execute') as for_bot_service
      `;
      assert.strictEqual(granted[0].for_anon, false, `Test 9: ${fn.name} is executable by anon`);
      assert.strictEqual(
        granted[0].for_authenticated,
        fn.audience === 'auth',
        `Test 9: unexpected authenticated privilege on ${fn.name}`
      );
      assert.strictEqual(
        granted[0].for_bot_service,
        fn.audience === 'bot',
        `Test 9: unexpected bot_service privilege on ${fn.name}`
      );
    }
    console.log('✅ Test 9 Passed.');

    console.log('\n🎉 ALL REPO-LINK TESTS PASSED SUCCESSFULLY! 🎉');
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

type GrantRow = {
  for_authenticated: boolean;
  for_anon: boolean;
  for_bot_service: boolean;
};

/** Fixture-scoped teardown (AGENTS.md rule 4): never an unscoped delete. */
async function cleanup(sql: postgres.Sql) {
  await sql`delete from public.repo_links where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.github_installations where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.github_connect_invites where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.threads where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.groups where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.authorizations where entity_id in (${E1}, ${E2})`;
  await sql`delete from public.entities where id in (${E1}, ${E2})`;
  await sql`delete from auth.users where id in ${sql(ALL_USERS)}`;
}

main();
