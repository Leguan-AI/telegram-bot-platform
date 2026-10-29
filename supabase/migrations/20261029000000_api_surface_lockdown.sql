-- =============================================================
-- API surface lockdown: function EXECUTE, table privileges, default privileges
-- =============================================================
-- Mirrors the Leguan Options hardening (leguan-options issue #13 / PR #14) for this project.
--
-- Why: every function in public that never had an explicit revoke was executable by PUBLIC (and so
-- by anon, the browser's publishable key) because Postgres grants EXECUTE to PUBLIC on new
-- functions, and Supabase's per-schema default privileges add anon/authenticated on top. Every
-- table also still carries Supabase's default arwdDxtm grants for anon and authenticated, so row
-- level security is the only thing between a browser key and tenant data (and TRUNCATE ignores RLS).
-- This migration makes the grants match what the app actually calls.
--
-- Result, in one line each:
--   * anon:           no table privilege, no function EXECUTE in public.
--   * authenticated:  EXECUTE only on the dashboard RPCs and the two helpers the RLS policies call;
--                     table privileges only for the paths app/manage uses directly
--                     (entities: select/insert/update, authorizations: select/delete).
--   * bot_service:    keeps every explicit grant it has; additionally keeps EXECUTE on
--                     get_current_entity_secret (lib/capabilities.ts) and on has_active_auth (called by
--                     the RLS policies on entities, which bot_service reads).
--   * new objects:    postgres-created functions, tables and sequences no longer auto-grant to
--                     PUBLIC/anon/authenticated.
--
-- Idempotent: create or replace, revoke, grant and alter default privileges are all safe to re-run.
-- No data is modified. Never edit this file once applied; add a new migration instead.


-- -------------------------------------------------------------
-- 1. Pin search_path on the three helpers that did not pin it to ''
-- -------------------------------------------------------------
-- Same signatures, parameter names and behaviour as the live definitions (verified against the live
-- function source on 2026-10-29), with every name schema-qualified and search_path = ''.
-- create or replace keeps the existing ACL; section 2 decides who can execute them.
create or replace function public.get_current_entity_secret(p_secret_id uuid)
returns text
language sql
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
  from vault.decrypted_secrets ds
  where ds.id = p_secret_id
    and exists (
      select 1 from public.entities e
      where e.id = nullif(pg_catalog.current_setting('app.current_entity_id', true), '')::uuid
        and p_secret_id in (
          e.telegram_bot_token_id,
          e.telegram_webhook_secret_id,
          e.github_token_id
        )
    );
$$;

create or replace function public.resolve_entity_id_by_slug(p_slug text)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select e.id from public.entities e where e.slug = p_slug;
$$;

create or replace function public.set_current_entity(entity_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.set_config('app.current_entity_id', entity_id::text, true);
end;
$$;


-- -------------------------------------------------------------
-- 2. Function EXECUTE: revoke everything the app does not call
-- -------------------------------------------------------------
-- Each group starts by revoking from public, anon, authenticated and bot_service (the last two
-- hold access through PUBLIC or an explicit grant), then grants back exactly what is needed.
-- service_role is untouched: Supabase's per-schema default gave it EXECUTE and it never reaches a
-- browser or this app.
--
-- (a) Dashboard RPCs called by the browser as `authenticated` (app/manage/**). Each one checks
--     auth.uid() against the entity inside the function. They had PUBLIC execute, so anon could
--     reach their entry point; they now require a signed-in session before the function runs.
revoke execute on function public.invite_user(uuid, text, text)       from public, anon, authenticated, bot_service;
revoke execute on function public.mint_link_token(uuid)               from public, anon, authenticated, bot_service;
revoke execute on function public.list_entity_groups(uuid)            from public, anon, authenticated, bot_service;
grant  execute on function public.invite_user(uuid, text, text)       to authenticated;
grant  execute on function public.mint_link_token(uuid)               to authenticated;
grant  execute on function public.list_entity_groups(uuid)            to authenticated;

-- (b) Helpers that RLS policies on entities and authorizations call. Postgres checks EXECUTE on a
--     function used in a policy against the role running the query:
--       has_active_auth: entity_management_select/update on entities, which `authenticated` (dashboard)
--                        and `bot_service` (reads entities under app.current_entity_id) both query;
--                        without the grant bot_service fails with "permission denied for function".
--       is_entity_owner: authorization_* policies, reached only by `authenticated`; bot_service holds
--                        no privilege on authorizations.
--     anon needs neither (it holds no table privilege). Both are SECURITY DEFINER and only ever
--     answer about auth.uid().
revoke execute on function public.has_active_auth(uuid, text)         from public, anon, authenticated, bot_service;
revoke execute on function public.is_entity_owner(uuid)               from public, anon, authenticated, bot_service;
grant  execute on function public.has_active_auth(uuid, text)         to authenticated, bot_service;
grant  execute on function public.is_entity_owner(uuid)               to authenticated;

-- (c) Secret-bearing bypass function called by the server (lib/capabilities.ts) as bot_service.
--     It returned Vault secrets to anon whenever app.current_entity_id was set; only bot_service
--     needs it.
revoke execute on function public.get_current_entity_secret(uuid)     from public, anon, authenticated, bot_service;
grant  execute on function public.get_current_entity_secret(uuid)     to bot_service;

-- (d) No caller in app/, lib/ or scripts/. Kept in the database for now; no API role can execute
--     them. (Re-grant to bot_service in a later migration if an out-of-repo caller turns up.)
--     resolve_entity_id_by_slug is a documented bootstrap resolver; set_current_entity is replaced
--     by set_config() in lib/supabase.ts.
revoke execute on function public.resolve_entity_id_by_slug(text)     from public, anon, authenticated, bot_service;
revoke execute on function public.set_current_entity(uuid)            from public, anon, authenticated, bot_service;

-- (e) Trigger functions. Postgres checks EXECUTE on a trigger function when the trigger is created,
--     not when it fires, so these revokes do not stop any trigger (including on_auth_user_created
--     firing as supabase_auth_admin). They were never meant to be callable as RPCs.
revoke execute on function public.handle_new_user()                   from public, anon, authenticated, bot_service;
revoke execute on function public.precheck_authorization_invite()     from public, anon, authenticated, bot_service;
revoke execute on function public.set_authorization_defaults()        from public, anon, authenticated, bot_service;
revoke execute on function public.set_entity_owner_on_insert()        from public, anon, authenticated, bot_service;
revoke execute on function public.prevent_entity_immutable_change()   from public, anon, authenticated, bot_service;
revoke execute on function public.enforce_repo_link_invariants()      from public, anon, authenticated, bot_service;
revoke execute on function public.prune_widowed_repo_pins()           from public, anon, authenticated, bot_service;
revoke execute on function public.touch_github_installation()         from public, anon, authenticated, bot_service;

-- (f) Already restricted by their own migrations and unchanged here: the github connect / context
--     document RPCs (authenticated), the bot_service-only functions (consume_link_token,
--     get_bot_config, get_current_bot_secret, resolve_bot_id_by_slug, resolve_entity_id_by_chat,
--     resolve_github_installation, peek_github_connect_invite, get_github_connection_for_admin,
--     set_repo_links, complete_github_connect) and is_entity_admin_profile (nobody but the owner).
--     normalize_context_doc_name keeps its authenticated grant (pure, touches no data).


-- -------------------------------------------------------------
-- 3. Default privileges for new objects
-- -------------------------------------------------------------
-- Postgres keeps two layers of default privileges for functions:
-- - The global layer (no "in schema") is where PUBLIC's EXECUTE on new functions comes from.
--   Per-schema defaults can only add to it, never remove from it, so PUBLIC is revoked here. This
--   applies to functions postgres creates in any schema.
-- - Supabase's per-schema entry for postgres in public grants EXECUTE to anon and authenticated;
--   the second statement removes them.
-- A later migration that needs a function callable by a role must now grant it explicitly.
--
-- Not covered: Supabase's own entries for supabase_admin in public (it creates the objects of
-- extensions installed there, such as citext). postgres cannot alter another role's defaults;
-- install new extensions into the extensions schema.
alter default privileges for role postgres
  revoke execute on functions from public;

alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;

alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;


-- -------------------------------------------------------------
-- 4. Table and sequence privileges for the Supabase API roles
-- -------------------------------------------------------------
-- Start from nothing for anon and authenticated, then grant back SELECT/INSERT/UPDATE/DELETE only
-- on the three tables that have RLS policies written for the authenticated role (every other table
-- is reached through SECURITY DEFINER functions, which do not consult the caller's table
-- privileges, or by bot_service, whose grants are unchanged):
--   entities        entity_management_select/insert/update/delete
--   authorizations  authorization_select/insert/update/delete
--   profiles        profiles_policy (own row)
-- The browser today only uses entities (select, insert, update) and authorizations (select, delete);
-- the rest is kept because a policy exists for it and tests/test-management-rls.ts exercises it.
-- It can be narrowed later without touching anything else. RLS still applies on top of these.
-- TRUNCATE, REFERENCES and TRIGGER are never granted: TRUNCATE ignores RLS entirely.
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select, insert, update, delete on public.entities       to authenticated;
grant select, insert, update, delete on public.authorizations to authenticated;
grant select, insert, update, delete on public.profiles       to authenticated;


-- -------------------------------------------------------------
-- 5. Self-check: fail the migration if the end state is wrong
-- -------------------------------------------------------------
do $$
declare
  v_bad text;
begin
  -- No anon/PUBLIC-executable function the repo owns (extension functions such as citext's are
  -- excluded; they are not ours to change).
  select string_agg(p.oid::regprocedure::text, ', ')
    into v_bad
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.prokind = 'f'
    and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
    and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'api_surface_lockdown: anon can still execute: %', v_bad;
  end if;

  -- anon holds no privilege on any table or sequence in public.
  select string_agg(c.oid::regclass::text, ', ')
    into v_bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
    and (has_any_column_privilege('anon', c.oid, 'select, insert, update, references')
         or has_table_privilege('anon', c.oid, 'delete, truncate, trigger'));
  if v_bad is not null then
    raise exception 'api_surface_lockdown: anon can still reach: %', v_bad;
  end if;

  -- authenticated never holds TRUNCATE/REFERENCES/TRIGGER on a table in public.
  select string_agg(c.oid::regclass::text, ', ')
    into v_bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace
    and c.relkind in ('r', 'p')
    and has_table_privilege('authenticated', c.oid, 'truncate, references, trigger');
  if v_bad is not null then
    raise exception 'api_surface_lockdown: authenticated still holds truncate/references/trigger on: %', v_bad;
  end if;
end
$$;
