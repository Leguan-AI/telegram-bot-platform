// Adversarial test suite for topic pins and scope resolution (#21 §3a).
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-repo-pins.ts
//
// WARNING: this harness inserts and deletes fixture rows in auth.users, public.entities,
// public.groups and public.threads (all UUID-scoped). Run it against a Supabase branch or
// staging database, NOT production: an interrupted run would leave fake auth users and
// entities behind.
//
// OPERATOR-RUN ONLY; it applies no migrations (20261022010000 and 20261022020000 are
// enough, and both are already applied).
//
// It exercises lib/repoScope.ts directly — the same code the /repos handler calls — so
// what is tested is the resolution the bot actually performs, not a copy of its SQL. With
// no GitHub App credentials in the environment, name lookup degrades to ids, which is
// exactly the path asserted here; the command's parsing and formatting are covered without
// a database by scripts/test-repos-command.ts.

import postgres from 'postgres';
import assert from 'assert';

import { resolveRepoScope, setTopicPins, getActiveInstallationRow, getThreadRowId } from '../lib/repoScope';

// Fixtures, distinct from every other harness in scripts/.
const OWNER_A = 'fa500000-0000-0000-0000-0000000000a1';
const OWNER_B = 'fb500000-0000-0000-0000-0000000000b1';
const ALL_USERS = [OWNER_A, OWNER_B];

const E1 = 'f5100000-0000-0000-0000-0000000000e1';
const E2 = 'f5200000-0000-0000-0000-0000000000e2';
const G1 = 'f5100000-0000-0000-0000-0000000000a1';
const G2 = 'f5200000-0000-0000-0000-0000000000a2';
const T1 = 'f5100000-0000-0000-0000-0000000000b1';
const T2 = 'f5100000-0000-0000-0000-0000000000b2';

const CHAT_1 = '9940001';
const CHAT_2 = '9940002';
const TG_THREAD_1 = 7301;
const TG_THREAD_2 = 7302;
const INSTALL_A = '9941001';
const INSTALL_B = '9941002';
const REPO_1 = 5554001;
const REPO_2 = 5554002;
const REPO_UNLINKED = 5559999;
const PINNER = 424242;

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;

  let sql: postgres.Sql | null = null;

  try {
    if (!adminUrl || !botUrl) {
      throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required to run these tests.');
    }

    sql = postgres(adminUrl, { max: 10, prepare: false });

    const expectRaise = async (expected: string, fn: () => Promise<unknown>, label: string) => {
      try {
        await fn();
      } catch (e: any) {
        assert.strictEqual(e.message, expected, `${label}: expected "${expected}", got "${e.message}"`);
        return;
      }
      assert.fail(`${label}: expected "${expected}" but the call succeeded`);
    };

    console.log('--- Setting Up Test Environment ---');
    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_A, 'pin_owner_a@test.com'],
      [OWNER_B, 'pin_owner_b@test.com'],
    ]) {
      await sql`
        insert into auth.users (id, email, email_confirmed_at, aud, role)
        values (${id}, ${email}, now(), 'authenticated', 'authenticated')
      `;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E1}, 'pin-entity-1-test', 'Pin Entity 1', ${OWNER_A}, 'pin_test_bot')`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id, telegram_bot_username)
              values (${E2}, 'pin-entity-2-test', 'Pin Entity 2', ${OWNER_B}, 'pin_test_bot_2')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G1}, ${E1}, ${CHAT_1}, 'Pin Group 1')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name)
              values (${G2}, ${E2}, ${CHAT_2}, 'Pin Group 2')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
              values (${T1}, ${E1}, ${G1}, ${TG_THREAD_1}, 'Mobile')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name)
              values (${T2}, ${E1}, ${G1}, ${TG_THREAD_2}, 'Backend')`;

    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E1}, ${INSTALL_A}, 9301, 'pin-acme', 'Organization', 'selected', 'active')`;
    await sql`insert into public.github_installations (
                entity_id, installation_id, account_id, account_login, account_type,
                repository_selection, status
              ) values (${E2}, ${INSTALL_B}, 9302, 'pin-other', 'Organization', 'selected', 'active')`;

    const inst1 = (await sql<{ id: string }[]>`select id from public.github_installations where entity_id = ${E1}`)[0].id;
    const inst2 = (await sql<{ id: string }[]>`select id from public.github_installations where entity_id = ${E2}`)[0].id;

    // Entity-wide REPO_1, group-level REPO_2 — the two scopes a topic inherits from.
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E1}, ${inst1}, null, null, ${REPO_1})`;
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E1}, ${inst1}, ${G1}, null, ${REPO_2})`;
    // The other tenant links the same repo ids, which must never bleed across.
    await sql`insert into public.repo_links (entity_id, github_installation_id, group_id, thread_id, repo_id)
              values (${E2}, ${inst2}, ${G2}, null, ${REPO_1})`;

    console.log('Setup completed. Running tests...\n');

    // =========================================================================
    // Test 1: an unpinned topic inherits the group's and the entity's links
    // =========================================================================
    console.log('Test 1: inheritance...');
    const groupScope = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: null });
    assert.strictEqual(groupScope.status, 'active');
    assert.deepStrictEqual(groupScope.repos.map((r) => r.repoId).sort(), [REPO_1, REPO_2]);
    assert.strictEqual(groupScope.isPinned, false);

    const unpinnedTopic = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.deepStrictEqual(unpinnedTopic.repos.map((r) => r.repoId).sort(), [REPO_1, REPO_2]);
    assert.strictEqual(unpinnedTopic.isPinned, false, 'an unpinned topic must not claim to be pinned');
    console.log('✅ Test 1 Passed.');

    // =========================================================================
    // Test 2: pinning narrows the topic, and records who did it
    // =========================================================================
    console.log('Test 2: pinning...');
    const installationRowId = await getActiveInstallationRow(E1);
    assert.strictEqual(installationRowId, inst1, 'Test 2: wrong installation row');
    const threadRowId = await getThreadRowId({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.strictEqual(threadRowId, T1, 'Test 2: wrong thread row');

    await setTopicPins({
      entityId: E1,
      groupId: G1,
      threadRowId: T1,
      installationRowId: inst1,
      repoIds: [REPO_2],
      telegramUserId: PINNER,
    });

    const pinned = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.deepStrictEqual(pinned.repos.map((r) => r.repoId), [REPO_2], 'Test 2: the pin should be the whole scope');
    assert.strictEqual(pinned.isPinned, true);
    assert.ok(pinned.repos.every((r) => r.pinned), 'Test 2: pinned repos should be marked');

    const recorded = await sql<{ linked_by_tg_user_id: string | null }[]>`
      select linked_by_tg_user_id::text from public.repo_links
      where entity_id = ${E1} and thread_id = ${T1}
    `;
    assert.strictEqual(recorded[0].linked_by_tg_user_id, PINNER.toString(), 'Test 2: the pinner was not recorded');

    // The sibling topic is untouched — pins are per topic.
    const sibling = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_2 });
    assert.strictEqual(sibling.isPinned, false, 'Test 2: pinning one topic must not pin another');
    assert.deepStrictEqual(sibling.repos.map((r) => r.repoId).sort(), [REPO_1, REPO_2]);
    console.log('✅ Test 2 Passed.');

    // =========================================================================
    // Test 3: a pin can only narrow
    // =========================================================================
    console.log('Test 3: pins cannot widen...');
    await expectRaise(
      'repo_pin_would_widen',
      () =>
        setTopicPins({
          entityId: E1,
          groupId: G1,
          threadRowId: T1,
          installationRowId: inst1,
          repoIds: [REPO_2, REPO_UNLINKED],
          telegramUserId: PINNER,
        }),
      'Test 3 unlinked repo'
    );

    // The refused write must not have taken the existing pins with it.
    const afterRefusal = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.deepStrictEqual(
      afterRefusal.repos.map((r) => r.repoId),
      [REPO_2],
      'Test 3: a refused pin change must leave the previous pins in place'
    );
    console.log('✅ Test 3 Passed.');

    // =========================================================================
    // Test 4: clearing returns the topic to what the group offers
    // =========================================================================
    console.log('Test 4: clearing...');
    await setTopicPins({
      entityId: E1,
      groupId: G1,
      threadRowId: T1,
      installationRowId: inst1,
      repoIds: [],
      telegramUserId: PINNER,
    });
    const cleared = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.strictEqual(cleared.isPinned, false, 'Test 4: the topic should inherit again');
    assert.deepStrictEqual(cleared.repos.map((r) => r.repoId).sort(), [REPO_1, REPO_2]);
    console.log('✅ Test 4 Passed.');

    // =========================================================================
    // Test 5: a topic may pin a repository linked entity-wide
    // =========================================================================
    console.log('Test 5: pinning an entity-level repo...');
    await setTopicPins({
      entityId: E1,
      groupId: G1,
      threadRowId: T1,
      installationRowId: inst1,
      repoIds: [REPO_1],
      telegramUserId: PINNER,
    });
    const entityPinned = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.deepStrictEqual(entityPinned.repos.map((r) => r.repoId), [REPO_1]);
    assert.strictEqual(entityPinned.isPinned, true);
    console.log('✅ Test 5 Passed.');

    // =========================================================================
    // Test 6: scope never crosses tenants, even with identical repository ids
    // =========================================================================
    console.log('Test 6: tenant isolation...');
    const otherTenant = await resolveRepoScope({ entityId: E2, groupId: G2, telegramThreadId: null });
    assert.deepStrictEqual(otherTenant.repos.map((r) => r.repoId), [REPO_1]);
    assert.strictEqual(otherTenant.isPinned, false, "Test 6: E1's pin must not appear for E2");

    // E1's group id with E2's entity id resolves to nothing, rather than to E1's links.
    const mismatched = await resolveRepoScope({ entityId: E2, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.deepStrictEqual(mismatched.repos.map((r) => r.repoId), [], 'Test 6: cross-tenant lookup leaked links');
    console.log('✅ Test 6 Passed.');

    // =========================================================================
    // Test 7: an unusable connection is reported, not silently empty
    // =========================================================================
    console.log('Test 7: connection states...');
    await sql`update public.github_installations set status = 'suspended' where entity_id = ${E1}`;
    const suspended = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.strictEqual(suspended.status, 'suspended', 'Test 7: a suspended installation must be reported');
    assert.strictEqual(
      await getActiveInstallationRow(E1),
      null,
      'Test 7: a suspended installation cannot take new pins'
    );

    await sql`update public.github_installations set status = 'pending_confirmation' where entity_id = ${E1}`;
    const pendingState = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.strictEqual(pendingState.status, 'pending_confirmation');

    await sql`update public.github_installations set status = 'active' where entity_id = ${E1}`;
    await sql`delete from public.github_installations where entity_id = ${E1}`;
    const disconnected = await resolveRepoScope({ entityId: E1, groupId: G1, telegramThreadId: TG_THREAD_1 });
    assert.strictEqual(disconnected.status, 'none', 'Test 7: a disconnected entity must say so');
    assert.deepStrictEqual(disconnected.repos, [], 'Test 7: links should have gone with the installation');
    console.log('✅ Test 7 Passed.');

    console.log('\n🎉 ALL REPO-PIN TESTS PASSED SUCCESSFULLY! 🎉');
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
  }
}

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
