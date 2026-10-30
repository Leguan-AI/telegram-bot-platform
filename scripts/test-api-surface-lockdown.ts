// Read-only catalog audit for supabase/migrations/20261029000000_api_surface_lockdown.sql.
// Run with: node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-api-surface-lockdown.ts
//
// Safe against any database: it only reads pg_catalog (has_function_privilege,
// has_table_privilege, pg_proc, pg_default_acl). It writes nothing and creates no fixtures.
// Uses ADMIN_DATABASE_URL (any role that can read the catalog works). The migration must
// already be applied by the operator (AGENTS.md rules 7 and 8); this harness never applies it.
//
// The expected ACL below is the PR's "kept grants" table: any function not listed here as kept
// for an API role must be unreachable by anon, authenticated and bot_service (except the
// functions the migration did not touch, listed in UNTOUCHED).

import postgres from 'postgres';
import assert from 'assert';

type Who = 'anon' | 'authenticated' | 'bot_service';

// function -> roles allowed to EXECUTE (everything else must be denied). Reason in comments.
const KEPT: Record<string, Who[]> = {
  // browser RPCs (supabase.rpc from app/manage) -> authenticated only
  'invite_user(uuid,text,text)': ['authenticated'],
  'mint_link_token(uuid)': ['authenticated'],
  'list_entity_groups(uuid)': ['authenticated'],
  'confirm_github_connection(uuid)': ['authenticated'],
  'create_context_doc(uuid,uuid,text,text)': ['authenticated'],
  'delete_context_doc(uuid,uuid)': ['authenticated'],
  'disconnect_github_connection(uuid)': ['authenticated'],
  'get_context_doc(uuid,uuid)': ['authenticated'],
  'get_github_connection(uuid)': ['authenticated'],
  'get_managed_context(uuid,uuid)': ['authenticated'],
  'list_context_docs(uuid)': ['authenticated'],
  'list_github_connect_invites(uuid)': ['authenticated'],
  'list_repo_links(uuid)': ['authenticated'],
  'mint_github_connect_token(uuid,text)': ['authenticated'],
  'normalize_context_doc_name(text)': ['authenticated'],
  'reject_github_connection(uuid)': ['authenticated'],
  'revoke_github_connect_invite(uuid,uuid)': ['authenticated'],
  'save_managed_context(uuid,uuid,text,timestamp with time zone)': ['authenticated'],
  'update_context_doc(uuid,uuid,text,text,timestamp with time zone)': ['authenticated'],
  // RLS policy helpers: evaluated as the querying role
  'has_active_auth(uuid,text)': ['authenticated', 'bot_service'], // entities policies (bot_service reads entities)
  'is_entity_owner(uuid)': ['authenticated'], // authorizations policies
  // server-side only (the bot's direct database connection, webhook and route handlers)
  'get_current_entity_secret(uuid)': ['bot_service'],
  'complete_github_connect(text,bigint,bigint,text,text,text,bigint,text)': ['bot_service'],
  'consume_link_token(text,uuid,bigint,bigint,text,boolean)': ['bot_service'],
  'get_bot_config(uuid)': ['bot_service'],
  'get_current_bot_secret(text)': ['bot_service'],
  'get_github_connection_for_admin(uuid,uuid)': ['bot_service'],
  'peek_github_connect_invite(text)': ['bot_service'],
  'resolve_bot_id_by_slug(text)': ['bot_service'],
  'resolve_entity_id_by_chat(bigint)': ['bot_service'],
  'resolve_github_installation(bigint)': ['bot_service'],
  'set_repo_links(uuid,uuid,uuid,uuid,bigint[])': ['bot_service'],
};

// Never reachable through the API by any role. Trigger functions do not need EXECUTE to fire.
const NO_API_ROLE = [
  'handle_new_user()',
  'precheck_authorization_invite()',
  'set_authorization_defaults()',
  'set_entity_owner_on_insert()',
  'prevent_entity_immutable_change()',
  'enforce_repo_link_invariants()',
  'prune_widowed_repo_pins()',
  'touch_github_installation()',
  'resolve_entity_id_by_slug(text)',
  'set_current_entity(uuid)',
  'is_entity_admin_profile(uuid,uuid)',
];

async function main() {
  const url = process.env.ADMIN_DATABASE_URL;
  if (!url) throw new Error('ADMIN_DATABASE_URL is required (read-only catalog queries only).');
  const sql = postgres(url, { max: 1 });
  try {
    const can = async (role: string, fn: string) =>
      (await sql`select has_function_privilege(${role}, ${'public.' + fn}::regprocedure, 'execute') as ok`)[0].ok as boolean;

    const roles: Who[] = ['anon', 'authenticated', 'bot_service'];

    // 1. Declared ACL
    for (const [fn, allowed] of Object.entries(KEPT)) {
      for (const r of roles) {
        assert.strictEqual(await can(r, fn), allowed.includes(r), `${fn}: ${r} execute should be ${allowed.includes(r)}`);
      }
    }
    for (const fn of NO_API_ROLE) {
      for (const r of roles) assert.strictEqual(await can(r, fn), false, `${fn}: ${r} must not execute`);
    }
    console.log('✅ Declared function ACL matches.');

    // 2. Nothing the repo owns is anon- or PUBLIC-executable (extension functions, e.g. citext, excluded)
    const anonFns = await sql`
      select p.oid::regprocedure::text as fn from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and has_function_privilege('anon', p.oid, 'execute')`;
    assert.deepStrictEqual(anonFns.map((r) => r.fn), [], 'no repo-owned function may be anon-executable');
    console.log('✅ No repo-owned function is anon-executable.');

    // 3. SECURITY DEFINER functions all pin an empty or fixed search_path
    const unpinned = await sql`
      select p.oid::regprocedure::text as fn from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`;
    assert.deepStrictEqual(unpinned.map((r) => r.fn), [], 'every SECURITY DEFINER function must pin search_path');
    console.log('✅ Every SECURITY DEFINER function pins search_path.');

    // 4. Table and sequence privileges
    const anonTables = await sql`
      select c.oid::regclass::text as rel from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p','v','m','S','f')
        and (has_any_column_privilege('anon', c.oid, 'select, insert, update, references')
             or has_table_privilege('anon', c.oid, 'delete, truncate, trigger'))`;
    assert.deepStrictEqual(anonTables.map((r) => r.rel), [], 'anon has no table or sequence privilege in public');
    const authAll = await sql`
      select c.oid::regclass::text as rel from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
        and has_table_privilege('authenticated', c.oid, 'select, insert, update, delete')
      order by 1`;
    assert.deepStrictEqual(authAll.map((r) => r.rel), ['authorizations', 'entities', 'profiles'],
      'authenticated has DML only on the three RLS-policy tables');
    const authBad = await sql`
      select c.oid::regclass::text as rel from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','p')
        and has_table_privilege('authenticated', c.oid, 'truncate, references, trigger')`;
    assert.deepStrictEqual(authBad.map((r) => r.rel), [], 'authenticated never holds truncate/references/trigger');
    console.log('✅ Table and sequence privileges for anon/authenticated are minimal.');

    // 5. Default privileges: new postgres-created objects in public no longer auto-grant
    const defaults = await sql`
      select d.defaclobjtype as kind, d.defaclnamespace::regnamespace::text as ns, d.defaclacl::text as acl
      from pg_default_acl d where d.defaclrole = 'postgres'::regrole`;
    for (const d of defaults) {
      if (d.ns !== 'public') continue;
      assert.ok(!/anon=|authenticated=/.test(d.acl as string), `default ACL kind ${d.kind} still grants anon/authenticated: ${d.acl}`);
    }
    console.log('✅ postgres default privileges in public no longer grant to anon/authenticated.');

    // 5b. Guard for "future functions need an explicit grant": postgres' GLOBAL default (no schema)
    // for functions must not grant EXECUTE to PUBLIC (an aclitem with an empty grantee prints as
    // '=X/postgres'). If it does, every function a later migration creates is callable by anon.
    const globalFn = await sql`
      select d.defaclacl::text as acl from pg_default_acl d
      where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'`;
    assert.ok(globalFn.length === 1, 'postgres must have a global default ACL for functions (PUBLIC execute revoked)');
    assert.ok(!/(^\{|,)=X\//.test(globalFn[0].acl as string), `global default still grants EXECUTE to PUBLIC: ${globalFn[0].acl}`);
    console.log('✅ Future postgres-created functions do not default to PUBLIC execute (explicit grants required).');

    // 5c. Informational: default privileges are per creating role. Defaults owned by any OTHER role
    // that still grant anon/authenticated apply to objects that role creates (the migration cannot
    // change them). Warn, do not fail: Supabase's own supabase_admin entries are expected.
    const otherDefaults = await sql`
      select d.defaclrole::regrole::text as owner, d.defaclobjtype as kind,
             d.defaclnamespace::regnamespace::text as ns, d.defaclacl::text as acl
      from pg_default_acl d
      where d.defaclrole <> 'postgres'::regrole and d.defaclacl::text ~ '(anon|authenticated)='`;
    for (const d of otherDefaults) {
      console.warn(`⚠️  default ACL owned by ${d.owner} (kind ${d.kind}, schema ${d.ns}) grants anon/authenticated: ${d.acl}`);
    }

    // 6. Watch item: bot_service must have no privilege on authorizations. That is why it does not
    // need EXECUTE on is_entity_owner (called by the authorizations policies). If this fails, grant
    // is_entity_owner to bot_service as well.
    const botAuthz = await sql`
      select has_any_column_privilege('bot_service', 'public.authorizations'::regclass, 'select, insert, update, references')
          or has_table_privilege('bot_service', 'public.authorizations'::regclass, 'delete, truncate, trigger') as ok`;
    assert.strictEqual(botAuthz[0].ok, false, 'bot_service must hold no privilege on authorizations (else it also needs EXECUTE on is_entity_owner)');
    console.log('✅ bot_service has no privilege on authorizations (so it does not need is_entity_owner).');

    console.log('\n🎉 API SURFACE LOCKDOWN VERIFIED');
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error('\n❌ Verification Failed:', err);
  process.exit(1);
});
