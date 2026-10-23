// Adversarial test suite for the GitHub webhook's database effects (#21 §4).
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-github-webhook-db.ts
//
// WARNING: this harness inserts and deletes fixture rows in auth.users, public.entities,
// public.groups and public.threads (all UUID-scoped). Run it against a Supabase branch or
// staging database, NOT production: an interrupted run would leave fake auth users and
// entities behind.
//
// OPERATOR-RUN ONLY, and it never pushes a migration: 20261023000000 must already be
// applied (AGENTS.md rules 7 and 8). It re-applies that migration's idempotent DDL only so
// repeat runs pick up local edits.
//
// The signature check and the event mapping are pure and covered without a database by
// scripts/test-github-webhook.ts; what is left for here is what the events do to rows.

import postgres from 'postgres';
import assert from 'assert';
import fs from 'fs';
import path from 'path';

// Fixtures, distinct from every other harness in scripts/.
const OWNER_A = 'ea000000-0000-0000-0000-0000000000a1';
const OWNER_B = 'eb000000-0000-0000-0000-0000000000b1';
const ALL_USERS = [OWNER_A, OWNER_B];

const E1 = 'e1100000-0000-0000-0000-0000000000e1';
const E2 = 'e2200000-0000-0000-0000-0000000000e2';
const G1 = 'e1100000-0000-0000-0000-0000000000a1';
const T1 = 'e1100000-0000-0000-0000-0000000000b1';

const CHAT_1 = '9930001';
const INSTALL_A = '9931001';
const INSTALL_B = '9931002';
const UNKNOWN_INSTALL = '9939999';
const REPO_1 = '5553001';
const REPO_2 = '5553002';

type AllowedRow = { allowed: boolean };

type Resolved = {
  entity_id: string;
  installation_row_id: string;
  status: string;
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

    const resolve = async (installationId: string): Promise<Resolved | null> => {
      const rows = await botSql!<{ result: Resolved | null }[]>`
        select public.resolve_github_installation(${installationId}) as result
      `;
      return rows[0].result;
    };

    /** The effects the route applies, run exactly as it does: inside the tenant context. */
    const withTenant = async <T>(entityId: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
      (await botSql!.begin(async (tx) => {
        await tx`select set_config('app.current_entity_id', ${entityId}, true)`;
        return await fn(tx);
      })) as T;

    const statusOf = async (entity: string) => {
      const rows = await sql!<{ status: string; repository_selection: string }[]>`
        select status, repository_selection from public.github_installations where entity_id = ${entity}
      `;
      return rows[0] || null;
    };

    const linkCount = async (entity: string) => {
      const rows = await sql!<{ c: string }[]>`
        select count(*)::text as c from public.repo_links where entity_id = ${entity}
      `;
      return rows[0].c;
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

    console.log('--- Applying Migration Schema (idempotent re-apply) ---');
    const migrationPath = path.join(__dirname, '../supabase/migrations/20261023000000_github_webhooks.sql');
    await sql.unsafe(fs.readFileSync(migrationPath, 'utf8'));

    console.log('--- Setting Up Test Environment ---');
    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_A, 'wh_owner_a@test.com'],
      [OWNER_B, 'wh_owner_b@test.com'],
    ]) {
      await sql`
        insert into auth.users (id, email, email_confirmed_at, aud, role)
        values (${id}, ${email}, now(), 'authenticated', 'authenticated')
      `;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'wh-entity-1-test', 'WH Entity 1', ${OWNER_A}, 'wh_test_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'wh-entity-2-test', 'WH Entity 2', ${OWNER_B}, 'wh_test_bot_2')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G1}, ${E1}, ${CHAT_1}, 'WH Group 1')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
              values (${T1}, ${E1}, ${G1}, 7201, 'Mobile')`;

    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E1}, ${INSTALL_A}, 9201, 'wh-acme', 'Organization', 'selected', 'active')`;
    // E2's connection is still awaiting an admin — the case suspension must not disturb.
    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E2}, ${INSTALL_B}, 9202, 'wh-other', 'Organization', 'selected', 'pending_confirmation')`;

    const inst1 = (await sql<{ id: string }[]>`select id from public.github_installations where entity_id = ${E1}`)[0].id;
    // Links at all three scopes, so an un-share has something to remove at each.
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E1}, ${inst1}, null, null, ${REPO_1})`;
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E1}, ${inst1}, ${G1}, null, ${REPO_2})`;
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E1}, ${inst1}, ${G1}, ${T1}, ${REPO_1})`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test 1: delivery dedupe
    // =========================================================================
    console.log('Test 1: delivery dedupe...');
    const delivery = 'wh-test-delivery-0001';
    const claim = async (id: string) =>
      (
        await botSql!`
          insert into public.github_webhook_deliveries (delivery_id, event)
          values (${id}, 'installation')
          on conflict (delivery_id) do nothing
          returning delivery_id
        `
      ).length > 0;

    assert.strictEqual(await claim(delivery), true, 'Test 1: first claim should succeed');
    assert.strictEqual(await claim(delivery), false, 'Test 1: a redelivery must be recognised');

    // Released after a failure, a redelivery becomes real work again.
    await botSql`delete from public.github_webhook_deliveries where delivery_id = ${delivery}`;
    assert.strictEqual(await claim(delivery), true, 'Test 1: a released id should be claimable again');
    await botSql`delete from public.github_webhook_deliveries where delivery_id = ${delivery}`;
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: the bootstrap resolver
    // =========================================================================
    console.log('Test 2: installation resolver...');
    assert.strictEqual(await resolve(UNKNOWN_INSTALL), null, 'Test 2: an unknown installation must resolve to null');

    const resolved = await resolve(INSTALL_A);
    assert.ok(resolved, 'Test 2: a connected installation should resolve');
    assert.strictEqual(resolved.entity_id, E1, 'Test 2: wrong entity');
    assert.strictEqual(resolved.status, 'active');
    assert.strictEqual(resolved.repository_selection, 'selected');

    // The dormant function this one replaces is gone, so the bypass count did not grow.
    const dropped = await sql<{ c: string }[]>`
      select count(*)::text as c from pg_proc
      where pronamespace = 'public'::regnamespace and proname = 'resolve_entity_id_by_repo'
    `;
    assert.strictEqual(dropped[0].c, '0', 'Test 2: resolve_entity_id_by_repo should have been dropped');

    const privs = await sql<{ auth: boolean; anon: boolean; bot: boolean }[]>`
      select
        has_function_privilege('authenticated'::name, 'public.resolve_github_installation(bigint)'::text, 'execute') as auth,
        has_function_privilege('anon'::name, 'public.resolve_github_installation(bigint)'::text, 'execute') as anon,
        has_function_privilege('bot_service'::name, 'public.resolve_github_installation(bigint)'::text, 'execute') as bot
    `;
    assert.strictEqual(privs[0].auth, false, 'Test 2: resolver must not be executable by authenticated');
    assert.strictEqual(privs[0].anon, false, 'Test 2: resolver must not be executable by anon');
    assert.strictEqual(privs[0].bot, true, 'Test 2: resolver must be executable by bot_service');
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: repository_selection refresh
    // =========================================================================
    console.log('Test 3: selection refresh...');
    await withTenant(E1, (tx) => tx`
      update public.github_installations set repository_selection = 'all' where id = ${inst1}
    `);
    assert.strictEqual((await statusOf(E1)).repository_selection, 'all', 'Test 3: selection not refreshed');
    assert.strictEqual(
      (await resolve(INSTALL_A))?.repository_selection,
      'all',
      'Test 3: the resolver should report the refreshed selection'
    );
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: suspend and unsuspend, and what they must not touch
    // =========================================================================
    console.log('Test 4: suspension...');
    const setSuspended = async (entity: string, rowId: string, suspended: boolean) => {
      const from = suspended ? 'active' : 'suspended';
      const to = suspended ? 'suspended' : 'active';
      return withTenant(entity, async (tx) => {
        const rows = await tx`
          update public.github_installations
          set status = ${to}
          where id = ${rowId} and status = ${from}
          returning id
        `;
        return rows.length;
      });
    };

    assert.strictEqual(await setSuspended(E1, inst1, true), 1, 'Test 4: active should suspend');
    assert.strictEqual((await statusOf(E1)).status, 'suspended');
    assert.strictEqual(
      await linkCount(E1),
      '3',
      'Test 4: suspension must not remove links — the installation is paused, not gone'
    );
    assert.strictEqual(await setSuspended(E1, inst1, false), 1, 'Test 4: suspended should unsuspend');
    assert.strictEqual((await statusOf(E1)).status, 'active');

    // The §2b guarantee: an unconfirmed connection stays unconfirmed through both events,
    // or unsuspend would activate a connection no admin ever confirmed.
    const inst2 = (await sql<{ id: string }[]>`select id from public.github_installations where entity_id = ${E2}`)[0].id;
    assert.strictEqual(await setSuspended(E2, inst2, true), 0, 'Test 4: suspend must not touch a pending connection');
    assert.strictEqual((await statusOf(E2)).status, 'pending_confirmation');
    assert.strictEqual(await setSuspended(E2, inst2, false), 0, 'Test 4: unsuspend must not activate a pending one');
    assert.strictEqual((await statusOf(E2)).status, 'pending_confirmation');
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: repositories removed — every scope, including pins
    // =========================================================================
    console.log('Test 5: repositories removed...');
    const removed = await withTenant(E1, async (tx) => {
      const rows = await tx`
        delete from public.repo_links
        where entity_id = ${E1}
          and repo_id = any (string_to_array(${REPO_1}, ',')::bigint[])
        returning id
      `;
      return rows.length;
    });
    assert.strictEqual(removed, 2, 'Test 5: both the entity-level link and its pin should go');
    assert.strictEqual(await linkCount(E1), '1', 'Test 5: the untouched group link should remain');

    const leftover = await sql<{ repo_id: string }[]>`
      select repo_id::text from public.repo_links where entity_id = ${E1}
    `;
    assert.deepStrictEqual(leftover.map((r) => r.repo_id), [REPO_2], 'Test 5: wrong link survived');
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: a webhook cannot reach another tenant's rows
    // =========================================================================
    console.log('Test 6: tenant isolation of the effects...');
    const strayDelete = await withTenant(E2, async (tx) => {
      const rows = await tx`
        delete from public.repo_links where entity_id = ${E1} returning id
      `;
      return rows.length;
    });
    assert.strictEqual(strayDelete, 0, "Test 6: E2's context must not delete E1's links");
    assert.strictEqual(await linkCount(E1), '1', "Test 6: E1's links were touched from another context");

    const strayUpdate = await withTenant(E2, async (tx) => {
      const rows = await tx`
        update public.github_installations set status = 'suspended' where id = ${inst1} returning id
      `;
      return rows.length;
    });
    assert.strictEqual(strayUpdate, 0, "Test 6: E2's context must not suspend E1's installation");
    assert.strictEqual((await statusOf(E1)).status, 'active');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: installation.deleted clears the connection and everything under it
    // =========================================================================
    console.log('Test 7: installation deleted...');
    const deleted = await withTenant(E1, async (tx) => {
      const rows = await tx`delete from public.github_installations where id = ${inst1} returning id`;
      return rows.length;
    });
    assert.strictEqual(deleted, 1, 'Test 7: the installation row should go');
    assert.strictEqual(await statusOf(E1), null, 'Test 7: the connection survived');
    assert.strictEqual(await linkCount(E1), '0', 'Test 7: links should cascade with the installation');
    assert.strictEqual(await resolve(INSTALL_A), null, 'Test 7: the resolver should no longer know it');
    console.log('✅ Test 7 Passed.');

    // =========================================================================
    // Test 8: the deliveries table holds no tenant data and is bot_service-only
    // =========================================================================
    console.log('Test 8: deliveries table posture...');
    const rls = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      select relrowsecurity, relforcerowsecurity from pg_class
      where relnamespace = 'public'::regnamespace and relname = 'github_webhook_deliveries'
    `;
    assert.ok(rls[0].relrowsecurity, 'Test 8: RLS not enabled');
    assert.ok(rls[0].relforcerowsecurity, 'Test 8: RLS not forced');

    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'github_webhook_deliveries'
      order by column_name
    `;
    assert.deepStrictEqual(
      columns.map((c) => c.column_name),
      ['created_at', 'delivery_id', 'event'],
      'Test 8: the table should carry no tenant column'
    );

    // The policy on this table is unconditional, so the grants are the whole boundary:
    // Supabase's default privileges would otherwise let anyone with the publishable key
    // read, insert and — worse — DELETE delivery ids, and deleting an id re-enables replay
    // of a captured signed delivery. Every verb is checked, not just select.
    for (const role of ['anon', 'authenticated']) {
      for (const verb of ['select', 'insert', 'update', 'delete', 'truncate']) {
        const granted: AllowedRow[] = await sql<AllowedRow[]>`
          select has_table_privilege(${role}::name, 'public.github_webhook_deliveries'::text, ${verb}) as allowed
        `;
        assert.strictEqual(
          granted[0].allowed,
          false,
          `Test 8: ${role} must not have ${verb} on github_webhook_deliveries`
        );
      }
    }

    // bot_service writes and releases, but never updates.
    const botPrivs = await sql<{ verb: string; allowed: boolean }[]>`
      select 'select' as verb, has_table_privilege('bot_service'::name, 'public.github_webhook_deliveries'::text, 'select') as allowed
      union all select 'insert', has_table_privilege('bot_service'::name, 'public.github_webhook_deliveries'::text, 'insert')
      union all select 'delete', has_table_privilege('bot_service'::name, 'public.github_webhook_deliveries'::text, 'delete')
      union all select 'update', has_table_privilege('bot_service'::name, 'public.github_webhook_deliveries'::text, 'update')
    `;
    for (const row of botPrivs) {
      assert.strictEqual(
        row.allowed,
        row.verb !== 'update',
        `Test 8: unexpected bot_service ${row.verb} privilege on github_webhook_deliveries`
      );
    }
    console.log('✅ Test 8 Passed.');

    // =========================================================================
    // Test 9: the connect-flow tables are not reachable by the browser roles either
    // =========================================================================
    console.log('Test 9: connect-table privileges...');
    for (const table of ['github_installations', 'repo_links', 'github_connect_invites']) {
      for (const role of ['anon', 'authenticated']) {
        for (const verb of ['select', 'insert', 'update', 'delete']) {
          const granted: AllowedRow[] = await sql<AllowedRow[]>`
            select has_table_privilege(${role}::name, ${'public.' + table}::text, ${verb}) as allowed
          `;
          assert.strictEqual(granted[0].allowed, false, `Test 9: ${role} must not have ${verb} on ${table}`);
        }
      }
    }
    // The dashboard reaches these through SECURITY DEFINER functions, which run as the
    // owner — so revoking the browser roles costs it nothing.
    const botStillWorks: AllowedRow[] = await sql<AllowedRow[]>`
      select has_table_privilege('bot_service'::name, 'public.repo_links'::text, 'select') as allowed
    `;
    assert.strictEqual(botStillWorks[0].allowed, true, 'Test 9: bot_service still needs repo_links');
    console.log('✅ Test 9 Passed.');

    console.log('\n🎉 ALL GITHUB WEBHOOK DB TESTS PASSED SUCCESSFULLY! 🎉');
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
  await sql`delete from public.github_webhook_deliveries where delivery_id like 'wh-test-delivery-%'`;
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
