// Verification suite for dashboard context management (list/get/save_managed_context).
// Run with: npx tsx scripts/test-dashboard-context.ts
//
// Requires the migration 20261022000000_dashboard_context_management.sql to already be applied by the
// operator (this script never applies migrations or touches the migration ledger). All rows are keyed to
// fixture UUIDs below; cleanup never runs an unscoped delete.

import postgres from 'postgres';
import assert from 'assert';

// Fixtures
const OWNER_U = 'a5000001-0000-0000-0000-000000000000';
const ADMIN_U = 'a5000002-0000-0000-0000-000000000000';
const EDITOR_U = 'a5000003-0000-0000-0000-000000000000';
const VIEWER_U = 'a5000004-0000-0000-0000-000000000000';
const STRANGER_U = 'a5000005-0000-0000-0000-000000000000';
const OTHER_OWNER_U = 'a5000006-0000-0000-0000-000000000000';
const ALL_USERS = [OWNER_U, ADMIN_U, EDITOR_U, VIEWER_U, STRANGER_U, OTHER_OWNER_U];

const E1 = 'e5000001-0000-0000-0000-000000000000';
const E2 = 'e5000002-0000-0000-0000-000000000000';
const G1 = 'f5000001-0000-0000-0000-000000000000';
const G1B = 'f5000002-0000-0000-0000-000000000000';
const G2 = 'f5000003-0000-0000-0000-000000000000';
const T1 = '75000001-0000-0000-0000-000000000000';
const D_PUSH = 'd5000001-0000-0000-0000-000000000000';
const D_MANUAL = 'd5000002-0000-0000-0000-000000000000';

async function runAsUser<T>(
  sql: postgres.Sql,
  userId: string,
  callback: (tx: postgres.TransactionSql) => Promise<T>
): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx`set local role = 'authenticated'`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: userId })}, true)`;
    await tx`set local row_security = on`;
    return await callback(tx);
  })) as T;
}

async function expectError(p: Promise<unknown>, match: RegExp, label: string) {
  try {
    await p;
  } catch (err: any) {
    assert.ok(match.test(`${err.code ?? ''} ${err.message ?? ''}`), `${label}: unexpected error "${err.message}"`);
    return;
  }
  assert.fail(`${label}: expected an error matching ${match} but the call succeeded`);
}

const save = (sql: postgres.Sql, user: string, entity: string, group: string | null, content: string, expected: string | null) =>
  runAsUser(sql, user, async (tx) => {
    const rows = await tx<{ ts: string }[]>`
      select public.save_managed_context(${entity}::uuid, ${group}::uuid, ${content}, ${expected}::timestamptz)::text as ts`;
    return rows[0].ts;
  });

const getCtx = (sql: postgres.Sql, user: string, entity: string, group: string | null) =>
  runAsUser(sql, user, async (tx) =>
    tx<{ doc_id: string; content: string; updated_at: string }[]>`
      select doc_id, content, updated_at::text as updated_at from public.get_managed_context(${entity}::uuid, ${group}::uuid)`);

const listDocs = (sql: postgres.Sql, user: string, entity: string) =>
  runAsUser(sql, user, async (tx) =>
    tx<any[]>`select * from public.list_context_docs(${entity}::uuid)`);

async function cleanup(sql: postgres.Sql) {
  // Fixture-scoped only. Deleting the entities cascades groups, threads, doc_cache, manifest_entries, authorizations.
  await sql`delete from public.entities where id in (${E1}, ${E2})`;
  await sql`delete from auth.users where id in ${sql(ALL_USERS)}`;
}

async function main() {
  const adminUrl = process.env.ADMIN_DATABASE_URL;
  const botUrl = process.env.DATABASE_URL;
  if (!adminUrl || !botUrl) {
    throw new Error('Both ADMIN_DATABASE_URL and DATABASE_URL are required.');
  }

  const sql = postgres(adminUrl, { max: 6, prepare: false });
  const botSql = postgres(botUrl, { max: 2, prepare: false });

  try {
    const fn = await sql`select count(*)::int as c from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                         where n.nspname = 'public' and p.proname in ('list_context_docs', 'get_managed_context', 'save_managed_context')`;
    if (fn[0].c !== 3) {
      throw new Error(
        'Migration 20261022000000_dashboard_context_management.sql is not applied. ' +
          'Run `supabase db push` (operator step) before this harness.'
      );
    }

    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_U, 'ctx_owner@test.com'], [ADMIN_U, 'ctx_admin@test.com'], [EDITOR_U, 'ctx_editor@test.com'],
      [VIEWER_U, 'ctx_viewer@test.com'], [STRANGER_U, 'ctx_stranger@test.com'], [OTHER_OWNER_U, 'ctx_other@test.com'],
    ]) {
      await sql`insert into auth.users (id, email, email_confirmed_at, aud, role)
                values (${id}, ${email}, now(), 'authenticated', 'authenticated')`;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id) values (${E1}, 'ctx-entity-1', 'Ctx Entity 1', ${OWNER_U})`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id) values (${E2}, 'ctx-entity-2', 'Ctx Entity 2', ${OTHER_OWNER_U})`;
    for (const [uid, role] of [[ADMIN_U, 'admin'], [EDITOR_U, 'editor'], [VIEWER_U, 'viewer']]) {
      await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
                values (${E1}, ${uid}, ${role}, 'active', ${OWNER_U})`;
    }
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${G1}, ${E1}, -1005000001, 'Group One')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${G1B}, ${E1}, -1005000002, 'Group Two')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${G2}, ${E2}, -1005000003, 'Other Entity Group')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name) values (${T1}, ${E1}, ${G1}, 5001, 'Launch topic')`;

    // Pre-existing non-dashboard documents: a /push doc at topic scope, a manual-SQL doc at entity scope
    await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type, source)
              values (${D_PUSH}, ${E1}, 'launch-notes', 'push content', 'push', '{"pushed_via":"telegram_push"}'::jsonb)`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${G1}, ${T1}, ${D_PUSH})`;
    await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type)
              values (${D_MANUAL}, ${E1}, 'seeded-overview', 'seeded via sql', 'manual')`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, null, null, ${D_MANUAL})`;

    // ---------------------------------------------------------------- 1. Authorization
    console.log('Test 1: authorization...');
    for (const fnCall of [
      () => listDocs(sql, STRANGER_U, E1),
      () => getCtx(sql, STRANGER_U, E1, null),
      () => save(sql, STRANGER_U, E1, null, 'x', null),
      () => save(sql, VIEWER_U, E1, null, 'x', null),
      () => save(sql, OWNER_U, E2, null, 'x', null), // owner of E1 writing E2
      () => listDocs(sql, OWNER_U, E2),
    ]) {
      await expectError(fnCall(), /42501|Access Denied/, 'authz');
    }
    const strangerDirect = await runAsUser(sql, STRANGER_U, async (tx) => tx`select count(*)::int as c from public.doc_cache`);
    assert.strictEqual(strangerDirect[0].c, 0, 'direct table read sees zero rows (no RLS path)');
    assert.strictEqual((await getCtx(sql, VIEWER_U, E1, null)).length, 0, 'viewer can read (empty)');
    console.log('✅ Test 1 passed.');

    // ---------------------------------------------------------------- 2. Save / read / list: entity scope
    console.log('Test 2: entity-wide save, read, list...');
    const ts1 = await save(sql, OWNER_U, E1, null, '  # Overview\n\nWe are Ctx.  \n', null);
    const got = await getCtx(sql, VIEWER_U, E1, null);
    assert.strictEqual(got.length, 1);
    assert.strictEqual(got[0].content, '# Overview\n\nWe are Ctx.', 'content is trimmed');
    assert.strictEqual(got[0].updated_at, ts1, 'get returns the exact timestamp save returned');
    let docs = await listDocs(sql, VIEWER_U, E1);
    const entityManaged = docs.find((d) => d.managed && d.scope === 'entity');
    assert.ok(entityManaged, 'managed entity doc listed');
    assert.strictEqual(entityManaged.display_name, 'entity-context');
    assert.ok(docs.find((d) => d.display_name === 'seeded-overview' && d.scope === 'entity' && d.managed === false), 'manual SQL doc listed, unmanaged');
    console.log('✅ Test 2 passed.');

    // ---------------------------------------------------------------- 3. Roles that can write
    console.log('Test 3: owner/admin/editor can update, with optimistic concurrency...');
    const ts2 = await save(sql, ADMIN_U, E1, null, 'v2 by admin', ts1);
    assert.notStrictEqual(ts2, ts1);
    const ts3 = await save(sql, EDITOR_U, E1, null, 'v3 by editor', ts2);
    await expectError(save(sql, OWNER_U, E1, null, 'stale write', ts1), /context_conflict/, 'stale timestamp');
    await expectError(save(sql, OWNER_U, E1, null, 'no timestamp', null), /context_conflict/, 'null timestamp when doc exists');
    assert.strictEqual((await getCtx(sql, OWNER_U, E1, null))[0].content, 'v3 by editor', 'conflicting writes changed nothing');
    const ts4 = await save(sql, OWNER_U, E1, null, 'v4 by owner', ts3);
    assert.ok(ts4);
    const edited = await sql`select source->>'edited_by' as by from public.doc_cache where id = ${got[0].doc_id}`;
    assert.strictEqual(edited[0].by, OWNER_U, 'edited_by recorded');
    // Still exactly one managed entity doc
    const managedCount = await sql`select count(*)::int as c from public.manifest_entries m join public.doc_cache c on c.id = m.doc_id
                                   where m.entity_id = ${E1} and m.group_id is null and c.source->>'managed_by' = 'dashboard'`;
    assert.strictEqual(managedCount[0].c, 1);
    await expectError(save(sql, OWNER_U, E1, G1, 'wrong expected for new scope', ts4), /context_conflict/, 'expected ts when no doc at scope');
    console.log('✅ Test 3 passed.');

    // ---------------------------------------------------------------- 4. Group scope is independent
    console.log('Test 4: group scope...');
    const g1ts = await save(sql, EDITOR_U, E1, G1, 'Group One context', null);
    const g1bts = await save(sql, EDITOR_U, E1, G1B, 'Group Two context', null);
    assert.strictEqual((await getCtx(sql, OWNER_U, E1, G1))[0].content, 'Group One context');
    assert.strictEqual((await getCtx(sql, OWNER_U, E1, G1B))[0].content, 'Group Two context');
    assert.strictEqual((await getCtx(sql, OWNER_U, E1, null))[0].content, 'v4 by owner', 'entity doc unaffected');
    await save(sql, OWNER_U, E1, G1, 'Group One v2', g1ts);
    assert.ok(g1bts);
    // Pre-existing push doc untouched; listed as unmanaged topic doc with thread name
    const pushRow = (await listDocs(sql, OWNER_U, E1)).find((d) => d.display_name === 'launch-notes');
    assert.ok(pushRow && pushRow.scope === 'topic' && pushRow.managed === false && pushRow.thread_name === 'Launch topic' && pushRow.group_name === 'Group One');
    const pushStill = await sql`select content from public.doc_cache where id = ${D_PUSH}`;
    assert.strictEqual(pushStill[0].content, 'push content', 'push doc untouched');
    const manualStill = await sql`select content from public.doc_cache where id = ${D_MANUAL}`;
    assert.strictEqual(manualStill[0].content, 'seeded via sql', 'manual SQL doc untouched (never adopted as managed)');
    console.log('✅ Test 4 passed.');

    // ---------------------------------------------------------------- 5. Validation
    console.log('Test 5: validation...');
    await expectError(save(sql, OWNER_U, E1, null, '   \n ', (await getCtx(sql, OWNER_U, E1, null))[0].updated_at), /empty_content/, 'whitespace-only');
    await expectError(save(sql, OWNER_U, E1, G1, 'x'.repeat(262145), (await getCtx(sql, OWNER_U, E1, G1))[0].updated_at), /content_too_large/, 'over 256 KB');
    await save(sql, OWNER_U, E1, G1B, 'y'.repeat(262144), (await getCtx(sql, OWNER_U, E1, G1B))[0].updated_at); // exactly at the cap is fine
    await expectError(save(sql, OWNER_U, E1, G2, 'cross-entity group', null), /group_not_in_entity/, 'save: group from another entity');
    await expectError(getCtx(sql, OWNER_U, E1, G2), /group_not_in_entity/, 'get: group from another entity');
    console.log('✅ Test 5 passed.');

    // ---------------------------------------------------------------- 6. Concurrent first saves
    console.log('Test 6: concurrent first-saves create one document...');
    const staleDocs = await sql<{ doc_id: string }[]>`select doc_id from public.manifest_entries where entity_id = ${E1} and group_id = ${G1B}`;
    await sql`delete from public.doc_cache where id in ${sql(staleDocs.map((r) => r.doc_id))}`; // cascades the manifest row
    const results = await Promise.allSettled([
      save(sql, EDITOR_U, E1, G1B, 'racer A', null),
      save(sql, ADMIN_U, E1, G1B, 'racer B', null),
    ]);
    assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one racer wins');
    assert.strictEqual(results.filter((r) => r.status === 'rejected' && /context_conflict/.test((r as any).reason.message)).length, 1, 'the loser gets context_conflict');
    const racers = await sql`select count(*)::int as c from public.manifest_entries m join public.doc_cache c on c.id = m.doc_id
                             where m.entity_id = ${E1} and m.group_id = ${G1B} and c.source->>'managed_by' = 'dashboard'`;
    assert.strictEqual(racers[0].c, 1, 'one managed doc after the race');
    console.log('✅ Test 6 passed.');

    // ---------------------------------------------------------------- 7. Bot read path sees dashboard docs
    console.log('Test 7: bot read path (same query shape as buildContext)...');
    const botDocs = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      return tx<{ thread_id: string | null; group_id: string | null; display_name: string; content: string }[]>`
        select m.thread_id, m.group_id, c.display_name, c.content
        from manifest_entries m
        join doc_cache c on c.id = m.doc_id
        left join threads t on t.id = m.thread_id
        where m.entity_id = ${E1}
          and (m.group_id is null or m.group_id = ${G1}::uuid)
          and (m.thread_id is null or t.telegram_thread_id = 5001::bigint)
        order by case when m.group_id is null and m.thread_id is null then 0 when m.thread_id is null then 1 else 2 end, m.created_at, m.doc_id`;
    });
    const names = botDocs.map((d) => d.display_name);
    assert.deepStrictEqual(names.slice().sort(), ['entity-context', 'group-context', 'launch-notes', 'seeded-overview'].sort());
    assert.strictEqual(botDocs.find((d) => d.display_name === 'entity-context')!.content, 'v4 by owner');
    assert.strictEqual(botDocs.find((d) => d.display_name === 'group-context')!.content, 'Group One v2');
    assert.ok(!names.includes('group-context') || botDocs.filter((d) => d.display_name === 'group-context').length === 1, "G1B's group-context never leaks into G1");
    const otherTenant = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E2}, true)`;
      return tx`select count(*)::int as c from manifest_entries`;
    });
    assert.strictEqual(otherTenant[0].c, 0, 'other tenant sees none of E1 context');
    console.log('✅ Test 7 passed.');

    console.log('\n🎉 ALL DASHBOARD CONTEXT TESTS PASSED 🎉');
  } finally {
    try {
      await cleanup(sql);
    } catch (err) {
      console.error('Cleanup failed:', err);
    }
    await sql.end();
    await botSql.end();
  }
}

main().catch((err) => {
  console.error('\n❌ TEST FAILED:', err);
  process.exit(1);
});
