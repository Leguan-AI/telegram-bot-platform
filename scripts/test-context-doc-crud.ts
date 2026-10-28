// Verification suite for the dashboard's context-document CRUD
// (create_context_doc / get_context_doc / update_context_doc / delete_context_doc).
// Run with: npx tsx scripts/test-context-doc-crud.ts
//
// WARNING: this harness inserts and deletes fixture rows in auth.users and public.entities (UUID-scoped).
// Run it against a Supabase branch or staging database, NOT production: an interrupted run would leave
// fake auth users and entities behind. In production, verify with the dashboard UI instead.
//
// Requires the migrations 20261027000000_context_doc_crud.sql and
// 20261028000000_context_doc_update_fixes.sql to already be applied by the operator (this script
// never applies migrations or touches the migration ledger). All rows are keyed to the fixture
// UUIDs below; cleanup never runs an unscoped delete.

import postgres from 'postgres';
import assert from 'assert';

import { dedupeDocsByScope, docScopeOf } from '../lib/contextScope';

// Fixtures — a distinct prefix from test-dashboard-context.ts, so both may run against one database.
const OWNER_U = 'a6000001-0000-0000-0000-000000000000';
const ADMIN_U = 'a6000002-0000-0000-0000-000000000000';
const EDITOR_U = 'a6000003-0000-0000-0000-000000000000';
const VIEWER_U = 'a6000004-0000-0000-0000-000000000000';
const STRANGER_U = 'a6000005-0000-0000-0000-000000000000';
const OTHER_OWNER_U = 'a6000006-0000-0000-0000-000000000000';
const ALL_USERS = [OWNER_U, ADMIN_U, EDITOR_U, VIEWER_U, STRANGER_U, OTHER_OWNER_U];

const E1 = 'e6000001-0000-0000-0000-000000000000';
const E2 = 'e6000002-0000-0000-0000-000000000000';
const G1 = 'f6000001-0000-0000-0000-000000000000';
const G2 = 'f6000002-0000-0000-0000-000000000000'; // belongs to E2
const T1 = '76000001-0000-0000-0000-000000000000';
const D_PUSH = 'd6000001-0000-0000-0000-000000000000';
const D_OTHER = 'd6000002-0000-0000-0000-000000000000'; // lives in E2
// Two documents in one scope whose names differ only in case — not reachable through the dashboard,
// but reachable through /push from a chat or manual SQL, which is how these are made below.
const D_DUP_A = 'd6000003-0000-0000-0000-000000000000';
const D_DUP_B = 'd6000004-0000-0000-0000-000000000000';
const D_MULTI = 'd6000005-0000-0000-0000-000000000000'; // bound entity-wide AND to G1

interface DocRow {
  doc_id: string;
  display_name: string;
  content: string;
  source_type: string;
  managed: boolean;
  updated_at: string;
}

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

const createDoc = (sql: postgres.Sql, user: string, entity: string, group: string | null, name: string, content: string) =>
  runAsUser(sql, user, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select public.create_context_doc(${entity}::uuid, ${group}::uuid, ${name}, ${content}) as id`;
    return rows[0].id;
  });

const getDoc = (sql: postgres.Sql, user: string, entity: string, doc: string) =>
  runAsUser(sql, user, async (tx) =>
    tx<DocRow[]>`
      select doc_id, display_name, content, source_type, managed, updated_at::text as updated_at
      from public.get_context_doc(${entity}::uuid, ${doc}::uuid)`);

const updateDoc = (
  sql: postgres.Sql,
  user: string,
  entity: string,
  doc: string,
  name: string,
  content: string,
  expected: string | null
) =>
  runAsUser(sql, user, async (tx) => {
    const rows = await tx<{ ts: string }[]>`
      select public.update_context_doc(
        ${entity}::uuid, ${doc}::uuid, ${name}, ${content}, ${expected}::timestamptz
      )::text as ts`;
    return rows[0].ts;
  });

const deleteDoc = (sql: postgres.Sql, user: string, entity: string, doc: string) =>
  runAsUser(sql, user, async (tx) => {
    const rows = await tx<{ ok: boolean }[]>`
      select public.delete_context_doc(${entity}::uuid, ${doc}::uuid) as ok`;
    return rows[0].ok;
  });

const listDocs = (sql: postgres.Sql, user: string, entity: string) =>
  runAsUser(sql, user, async (tx) => tx<any[]>`select * from public.list_context_docs(${entity}::uuid)`);

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
                         where n.nspname = 'public'
                           and p.proname in ('create_context_doc', 'get_context_doc', 'update_context_doc',
                                             'delete_context_doc', 'normalize_context_doc_name')`;
    if (fn[0].c !== 5) {
      throw new Error(
        'Migration 20261027000000_context_doc_crud.sql is not applied. ' +
          'Run `supabase db push` (operator step) before this harness.'
      );
    }

    // Tests 9 and 10 check behaviour that only 20261028000000 gives update_context_doc. Without it
    // they would fail as if the fix were broken, so say what is actually missing.
    const fixed = await sql<{ ok: boolean }[]>`
      select pg_get_functiondef(p.oid) like '%pg_advisory_xact_lock%' as ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'update_context_doc'`;
    if (!fixed[0]?.ok) {
      throw new Error(
        'Migration 20261028000000_context_doc_update_fixes.sql is not applied. ' +
          'Run `supabase db push` (operator step) before this harness.'
      );
    }

    await cleanup(sql);

    for (const [id, email] of [
      [OWNER_U, 'crud_owner@test.com'], [ADMIN_U, 'crud_admin@test.com'], [EDITOR_U, 'crud_editor@test.com'],
      [VIEWER_U, 'crud_viewer@test.com'], [STRANGER_U, 'crud_stranger@test.com'], [OTHER_OWNER_U, 'crud_other@test.com'],
    ]) {
      await sql`insert into auth.users (id, email, email_confirmed_at, aud, role)
                values (${id}, ${email}, now(), 'authenticated', 'authenticated')`;
    }

    await sql`insert into public.entities (id, slug, display_name, owner_profile_id) values (${E1}, 'crud-entity-1', 'Crud Entity 1', ${OWNER_U})`;
    await sql`insert into public.entities (id, slug, display_name, owner_profile_id) values (${E2}, 'crud-entity-2', 'Crud Entity 2', ${OTHER_OWNER_U})`;
    for (const [uid, role] of [[ADMIN_U, 'admin'], [EDITOR_U, 'editor'], [VIEWER_U, 'viewer']]) {
      await sql`insert into public.authorizations (entity_id, profile_id, role, status, granted_by)
                values (${E1}, ${uid}, ${role}, 'active', ${OWNER_U})`;
    }
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${G1}, ${E1}, -1006000001, 'Group One')`;
    await sql`insert into public.groups (id, entity_id, telegram_chat_id, display_name) values (${G2}, ${E2}, -1006000002, 'Other Entity Group')`;
    await sql`insert into public.threads (id, entity_id, group_id, telegram_thread_id, name) values (${T1}, ${E1}, ${G1}, 6001, 'Roadmap')`;

    // A /push document at topic scope: the dashboard must be able to edit and delete it.
    await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type, source)
              values (${D_PUSH}, ${E1}, 'launch-notes', 'pushed content', 'push', '{"pushed_via":"telegram_push"}'::jsonb)`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${G1}, ${T1}, ${D_PUSH})`;
    // A document that belongs to the other entity — never reachable through E1.
    await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type)
              values (${D_OTHER}, ${E2}, 'other-tenant-doc', 'not yours', 'manual')`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E2}, null, null, ${D_OTHER})`;

    // ---------------------------------------------------------------- 1. Authorization
    console.log('Test 1: authorization...');
    for (const call of [
      () => createDoc(sql, STRANGER_U, E1, null, 'x', 'x'),
      () => createDoc(sql, VIEWER_U, E1, null, 'x', 'x'),
      () => createDoc(sql, OWNER_U, E2, null, 'x', 'x'), // owner of E1 writing E2
      () => getDoc(sql, STRANGER_U, E1, D_PUSH),
      () => updateDoc(sql, VIEWER_U, E1, D_PUSH, 'x', 'x', null),
      () => deleteDoc(sql, VIEWER_U, E1, D_PUSH),
      () => deleteDoc(sql, STRANGER_U, E1, D_PUSH),
    ]) {
      await expectError(call(), /42501|Access Denied/, 'authz');
    }
    assert.strictEqual((await getDoc(sql, VIEWER_U, E1, D_PUSH)).length, 1, 'a viewer may read a document');
    console.log('✅ Test 1 passed.');

    // ---------------------------------------------------------------- 2. Several documents per scope
    console.log('Test 2: many documents in one scope...');
    const dA = await createDoc(sql, OWNER_U, E1, null, '  Pricing and plans  ', '  # Pricing\n\nTiers.  \n');
    const dB = await createDoc(sql, EDITOR_U, E1, null, 'Support policy', 'We answer within a day.');
    const dC = await createDoc(sql, ADMIN_U, E1, G1, 'Group One handbook', 'Group One specifics.');
    assert.ok(dA && dB && dC && dA !== dB, 'three distinct documents created');

    const a = (await getDoc(sql, VIEWER_U, E1, dA))[0];
    assert.strictEqual(a.display_name, 'Pricing and plans', 'name is trimmed');
    assert.strictEqual(a.content, '# Pricing\n\nTiers.', 'content is trimmed');
    assert.strictEqual(a.managed, true, 'dashboard-created documents are marked managed');
    assert.strictEqual(a.source_type, 'manual');

    const docs = await listDocs(sql, VIEWER_U, E1);
    const entityNames = docs.filter((d) => d.scope === 'entity').map((d) => d.display_name).sort();
    assert.deepStrictEqual(entityNames, ['Pricing and plans', 'Support policy'], 'both entity documents listed');
    assert.ok(docs.find((d) => d.display_name === 'Group One handbook' && d.scope === 'group'), 'group document listed');
    console.log('✅ Test 2 passed.');

    // ---------------------------------------------------------------- 3. Names
    console.log('Test 3: name rules and per-scope uniqueness...');
    await expectError(createDoc(sql, OWNER_U, E1, null, 'pricing AND plans', 'dup'), /duplicate_doc_name/, 'case-insensitive duplicate');
    await expectError(createDoc(sql, OWNER_U, E1, null, '   ', 'x'), /empty_name/, 'blank name');
    await expectError(createDoc(sql, OWNER_U, E1, null, 'x'.repeat(121), 'x'), /name_too_long/, 'over 120 chars');
    await expectError(createDoc(sql, OWNER_U, E1, null, 'two\nlines', 'x'), /invalid_name/, 'newline in name');
    // The same name in a different scope is fine.
    const dD = await createDoc(sql, OWNER_U, E1, G1, 'Pricing and plans', 'Group-specific pricing.');
    assert.ok(dD, 'same name allowed in the group scope');
    await expectError(createDoc(sql, OWNER_U, E1, G2, 'cross-entity', 'x'), /group_not_in_entity/, 'group from another entity');
    console.log('✅ Test 3 passed.');

    // ---------------------------------------------------------------- 4. Content validation
    console.log('Test 4: content rules...');
    await expectError(createDoc(sql, OWNER_U, E1, null, 'blank doc', '  \n\t '), /empty_content/, 'whitespace-only content');
    await expectError(createDoc(sql, OWNER_U, E1, null, 'huge doc', 'x'.repeat(262145)), /content_too_large/, 'over 256 KB');
    const dBig = await createDoc(sql, OWNER_U, E1, null, 'at the cap', 'y'.repeat(262144));
    assert.ok(await deleteDoc(sql, OWNER_U, E1, dBig), 'exactly at the cap is accepted');
    console.log('✅ Test 4 passed.');

    // ---------------------------------------------------------------- 5. Update: rename, rewrite, concurrency
    console.log('Test 5: update...');
    const ts1 = await updateDoc(sql, EDITOR_U, E1, dA, 'Pricing', '# Pricing\n\nNew tiers.', a.updated_at);
    assert.notStrictEqual(ts1, a.updated_at);
    const afterRename = (await getDoc(sql, OWNER_U, E1, dA))[0];
    assert.strictEqual(afterRename.display_name, 'Pricing');
    assert.strictEqual(afterRename.content, '# Pricing\n\nNew tiers.');
    assert.strictEqual(afterRename.updated_at, ts1, 'get returns the exact timestamp update returned');

    await expectError(updateDoc(sql, OWNER_U, E1, dA, 'Pricing', 'stale', a.updated_at), /context_conflict/, 'stale timestamp');
    await expectError(updateDoc(sql, OWNER_U, E1, dA, 'Pricing', 'no timestamp', null), /context_conflict/, 'null timestamp');
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, dA))[0].content, '# Pricing\n\nNew tiers.', 'refused writes changed nothing');
    await expectError(updateDoc(sql, OWNER_U, E1, dA, 'support POLICY', 'x', ts1), /duplicate_doc_name/, 'rename onto a sibling');
    // Renaming to a name used only in another scope is fine.
    const ts2 = await updateDoc(sql, OWNER_U, E1, dA, 'Group One handbook', 'entity-level handbook', ts1);
    assert.ok(ts2);
    const edited = await sql`select source->>'edited_by' as by, source->>'edited_in_dashboard' as flag
                             from public.doc_cache where id = ${dA}`;
    assert.strictEqual(edited[0].by, OWNER_U, 'edited_by recorded');
    assert.strictEqual(edited[0].flag, 'true', 'edited_in_dashboard recorded');

    // A /push document is editable, and keeps saying it came from a chat.
    const push = (await getDoc(sql, OWNER_U, E1, D_PUSH))[0];
    assert.strictEqual(push.managed, false, 'a pushed document is not dashboard-managed');
    await updateDoc(sql, ADMIN_U, E1, D_PUSH, 'launch-notes', 'corrected by an admin', push.updated_at);
    const pushAfter = await sql`select content, source_type from public.doc_cache where id = ${D_PUSH}`;
    assert.strictEqual(pushAfter[0].content, 'corrected by an admin');
    assert.strictEqual(pushAfter[0].source_type, 'push', 'provenance is preserved');

    await expectError(updateDoc(sql, OWNER_U, E1, D_OTHER, 'x', 'x', null), /doc_not_found/, "another tenant's document");
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, D_OTHER)).length, 0, "another tenant's document is not readable");
    assert.strictEqual(
      (await sql`select content from public.doc_cache where id = ${D_OTHER}`)[0].content,
      'not yours',
      "another tenant's document is untouched"
    );
    console.log('✅ Test 5 passed.');

    // ---------------------------------------------------------------- 6. Delete
    console.log('Test 6: delete...');
    assert.strictEqual(await deleteDoc(sql, EDITOR_U, E1, dB), true, 'editor may delete');
    assert.strictEqual(await deleteDoc(sql, EDITOR_U, E1, dB), false, 'deleting twice is a no-op, not an error');
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, dB)).length, 0, 'the document is gone');
    const orphans = await sql`select count(*)::int as c from public.manifest_entries where doc_id = ${dB}`;
    assert.strictEqual(orphans[0].c, 0, 'the manifest entry cascaded away');
    assert.strictEqual(await deleteDoc(sql, OWNER_U, E1, D_OTHER), false, "another tenant's document cannot be deleted");
    assert.strictEqual(
      (await sql`select count(*)::int as c from public.doc_cache where id = ${D_OTHER}`)[0].c,
      1,
      "another tenant's document survives"
    );
    // A pushed topic document is removable from the dashboard.
    assert.strictEqual(await deleteDoc(sql, ADMIN_U, E1, D_PUSH), true, 'a pushed document is deletable');
    console.log('✅ Test 6 passed.');

    // ---------------------------------------------------------------- 7. Concurrent creates with one name
    console.log('Test 7: concurrent creates of the same name...');
    const racers = await Promise.allSettled([
      createDoc(sql, EDITOR_U, E1, null, 'Race doc', 'racer A'),
      createDoc(sql, ADMIN_U, E1, null, 'race DOC', 'racer B'),
    ]);
    assert.strictEqual(racers.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one racer wins');
    assert.strictEqual(
      racers.filter((r) => r.status === 'rejected' && /duplicate_doc_name/.test((r as any).reason.message)).length,
      1,
      'the loser gets duplicate_doc_name'
    );
    console.log('✅ Test 7 passed.');

    // ---------------------------------------------------------------- 8. Bot read path sees every document
    console.log('Test 8: bot read path (same query shape as buildContext)...');
    const botDocs = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      return tx<{ display_name: string; content: string }[]>`
        select c.display_name, c.content
        from manifest_entries m
        join doc_cache c on c.id = m.doc_id
        left join threads t on t.id = m.thread_id
        where m.entity_id = ${E1}
          and (m.group_id is null or m.group_id = ${G1}::uuid)
          and (m.thread_id is null or t.telegram_thread_id = 6001::bigint)
        order by case when m.group_id is null and m.thread_id is null then 0 when m.thread_id is null then 1 else 2 end,
                 m.created_at, m.doc_id`;
    });
    // The concurrent-create winner kept its own spelling, so compare names case-insensitively.
    const names = botDocs.map((d) => d.display_name.toLowerCase()).sort();
    assert.deepStrictEqual(
      names,
      ['group one handbook', 'group one handbook', 'pricing and plans', 'race doc'].sort(),
      'every document in scope reaches the bot, entity and group alike'
    );
    const otherTenant = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E2}, true)`;
      return tx<{ c: number }[]>`select count(*)::int as c from manifest_entries`;
    });
    assert.strictEqual(otherTenant[0].c, 1, 'the other tenant sees only its own document');
    console.log('✅ Test 8 passed.');

    // ---------------------------------------------------------------- 9. Editing content beside a duplicate name
    console.log('Test 9: a content-only edit is not blocked by a name clash it is not making...');
    // Only /push and manual SQL can put two folded-equal names in one scope (create_context_doc
    // refuses the second), so make them the way they really arise.
    for (const [id, name] of [[D_DUP_A, 'dup'], [D_DUP_B, 'Dup']]) {
      await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type, source)
                values (${id}, ${E1}, ${name}, 'original', 'push', '{"pushed_via":"telegram_push"}'::jsonb)`;
      await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, null, null, ${id})`;
    }

    const dupA = (await getDoc(sql, OWNER_U, E1, D_DUP_A))[0];
    const dupB = (await getDoc(sql, OWNER_U, E1, D_DUP_B))[0];
    // The defect: this refused with duplicate_doc_name, because the check ran on the unchanged name
    // and found the sibling. Neither document could ever be corrected again.
    const tsDupA = await updateDoc(sql, OWNER_U, E1, D_DUP_A, 'dup', 'corrected A', dupA.updated_at);
    assert.ok(tsDupA, 'the content of the lower-case one can be edited');
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, D_DUP_A))[0].content, 'corrected A');
    const tsDupB = await updateDoc(sql, ADMIN_U, E1, D_DUP_B, 'Dup', 'corrected B', dupB.updated_at);
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, D_DUP_B))[0].content, 'corrected B');
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, D_DUP_B))[0].display_name, 'Dup', 'the name is untouched');

    // A rename is still checked: taking a name a sibling already folds to stays a duplicate, and so
    // does a rename that only changes case onto the sibling's spelling.
    await expectError(
      updateDoc(sql, OWNER_U, E1, D_DUP_B, 'dup', 'x', tsDupB),
      /duplicate_doc_name/,
      "rename onto the sibling's folded name"
    );
    // dA was renamed to 'Group One handbook' at entity scope in test 5. ('Pricing and plans' would
    // be free here: test 3's document of that name is in G1's scope, not the entity's.)
    await expectError(
      updateDoc(sql, OWNER_U, E1, D_DUP_B, 'group ONE handbook', 'x', tsDupB),
      /duplicate_doc_name/,
      'rename onto another entity document'
    );
    // Renaming out of the clash works, and then the clash is gone.
    const tsDupB2 = await updateDoc(sql, OWNER_U, E1, D_DUP_B, 'Deduplicated', 'corrected B', tsDupB);
    assert.strictEqual((await getDoc(sql, OWNER_U, E1, D_DUP_B))[0].display_name, 'Deduplicated');
    console.log('✅ Test 9 passed.');

    // ---------------------------------------------------------------- 10. Concurrent renames to one name
    console.log('Test 10: concurrent renames to the same free name...');
    const freeName = 'Merged handbook';
    assert.strictEqual(
      (await listDocs(sql, OWNER_U, E1)).filter((d) => d.display_name.toLowerCase() === freeName.toLowerCase()).length,
      0,
      'the target name is free before the race'
    );
    // Both documents are at entity scope, so both renames compete for the one name. Before the fix
    // each held `for update` on its OWN row only, saw the name free, and wrote it.
    const renamers = await Promise.allSettled([
      updateDoc(sql, EDITOR_U, E1, D_DUP_A, freeName, 'corrected A', tsDupA),
      updateDoc(sql, ADMIN_U, E1, D_DUP_B, freeName, 'corrected B', tsDupB2),
    ]);
    assert.strictEqual(renamers.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one rename wins');
    assert.strictEqual(
      renamers.filter((r) => r.status === 'rejected' && /duplicate_doc_name/.test((r as any).reason.message)).length,
      1,
      'the loser gets duplicate_doc_name'
    );
    assert.strictEqual(
      (await listDocs(sql, OWNER_U, E1)).filter((d) => d.display_name === freeName).length,
      1,
      'the name ended up on exactly one document'
    );
    console.log('✅ Test 10 passed.');

    // ---------------------------------------------------------------- 11. One document, two bindings
    console.log('Test 11: a document bound to two scopes reaches the bot once...');
    await sql`insert into public.doc_cache (id, entity_id, display_name, content, source_type)
              values (${D_MULTI}, ${E1}, 'Shared handbook', 'read me once', 'manual')`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, null, null, ${D_MULTI})`;
    await sql`insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id) values (${E1}, ${G1}, null, ${D_MULTI})`;

    const multiBindings = await botSql.begin(async (tx) => {
      await tx`select set_config('app.current_entity_id', ${E1}, true)`;
      return tx<{ doc_id: string; group_id: string | null; thread_id: string | null }[]>`
        select m.doc_id, m.group_id, m.thread_id
        from manifest_entries m
        join doc_cache c on c.id = m.doc_id
        left join threads t on t.id = m.thread_id
        where m.entity_id = ${E1}
          and (m.group_id is null or m.group_id = ${G1}::uuid)
          and (m.thread_id is null or t.telegram_thread_id = 6001::bigint)
          and m.doc_id = ${D_MULTI}
        order by case when m.group_id is null and m.thread_id is null then 0 when m.thread_id is null then 1 else 2 end,
                 m.created_at, m.doc_id`;
    });
    // The query cannot help this: a row is a binding, so the document is selected twice.
    assert.strictEqual(multiBindings.length, 2, 'the join returns one row per binding');
    // What buildContext does with those rows (lib/contextScope.ts) — the unit tests in
    // scripts/test-context-budget.ts cover the logic; this checks the shape the database hands it.
    const deduped = dedupeDocsByScope(multiBindings, docScopeOf);
    assert.strictEqual(deduped.length, 1, 'the bot reads the document once');
    assert.strictEqual(docScopeOf(deduped[0]), 'group', 'at its most specific scope, so scope="group" is true');
    console.log('✅ Test 11 passed.');

    console.log('\n🎉 ALL CONTEXT DOCUMENT CRUD TESTS PASSED 🎉');
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
