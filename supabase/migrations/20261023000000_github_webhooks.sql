-- Migration: 20261023000000_github_webhooks.sql
-- GitHub App webhooks: delivery dedupe and the installation bootstrap (#21 §4)
--
-- Idempotent throughout (AGENTS.md rule 5).

-- -------------------------------------------------------------
-- 1. Delivery dedupe
--
-- GitHub does not retry automatically, but a delivery can be redelivered by hand from the
-- App's settings, and a retried request must not apply an event twice. The dedupe has to
-- happen BEFORE the installation is resolved, so this table is platform-level: it has no
-- entity_id, and holds nothing but a delivery id and what kind of event it was.
--
-- Rows are kept 7 days, which covers manual redelivery. The purge is a pg_cron job the
-- operator schedules, in the shape of the telegram_events one — see DEPLOYMENT.md A5d.
-- -------------------------------------------------------------

create table if not exists public.github_webhook_deliveries (
  delivery_id  text primary key,          -- X-GitHub-Delivery (a UUID from GitHub)
  event        text not null,             -- X-GitHub-Event
  created_at   timestamptz not null default now()
);

create index if not exists github_webhook_deliveries_created_idx
  on public.github_webhook_deliveries (created_at);

alter table public.github_webhook_deliveries enable row level security;
alter table public.github_webhook_deliveries force row level security;

-- Privileges FIRST, because this table's policy cannot do the isolating.
--
-- Supabase's platform default privileges hand `anon` and `authenticated` full DML on every
-- new table in `public` (verified on this database: a table created without explicit
-- revokes shows DELETE/INSERT/SELECT/UPDATE for both). Everywhere else that does not
-- matter, because the policy predicate — `entity_id = current_setting(...)` — is false for
-- a session with no entity context. Here the predicate has to be unconditional, since a
-- delivery id is not tenant data and the row must be written before we know which entity
-- the delivery concerns. With `using (true)` the predicate stops nothing, so the grants are
-- the whole boundary: left as Supabase creates them, anyone holding the publishable key
-- could read, insert and — worse — DELETE delivery ids, and deleting an id re-enables
-- replay of a captured signed delivery.
--
-- The same revoke-then-grant shape as 20260703000000_telegram_event_archive.sql.
revoke all on public.github_webhook_deliveries from public;
revoke all on public.github_webhook_deliveries from anon;
revoke all on public.github_webhook_deliveries from authenticated;
revoke all on public.github_webhook_deliveries from bot_service;

-- The route inserts, reads back the insert, and deletes on release. It never updates, and
-- the init schema's default privileges would otherwise have granted update too.
grant select, insert, delete on public.github_webhook_deliveries to bot_service;

drop policy if exists github_webhook_delivery_access on public.github_webhook_deliveries;
create policy github_webhook_delivery_access on public.github_webhook_deliveries
  to bot_service
  using (true)
  with check (true);

-- -------------------------------------------------------------
-- 2. The installation bootstrap resolver
--
-- SECURITY REVIEW (the init-schema invariant requires one for any RLS-bypass function).
--
-- Why it must bypass: a webhook arrives with an installation id and no tenant context.
-- Resolving it is the step that establishes which entity the request concerns, so it
-- cannot itself run under that entity's RLS — the same bootstrap shape as
-- resolve_entity_id_by_slug and resolve_entity_id_by_chat.
--
-- What it exposes: for a numeric installation id the caller already possesses, the entity
-- id, the installation row id and its status. No secret, no repository, no token, nothing
-- about any other installation. An unknown id returns null rather than an error, so it
-- cannot be used to tell "not mine" from "malformed".
--
-- Who can call it: `bot_service` only — revoked from public, anon and authenticated. The
-- route behind it has already verified the HMAC over the raw body, so an unauthenticated
-- caller never reaches it.
--
-- Probing: an attacker who could call it (they cannot) would learn only whether an
-- installation id is connected here. Installation ids are not secret, but they are also
-- not guessable in bulk, and the HMAC gate sits in front.
--
-- Count of bypass functions: unchanged. This REPLACES the dormant
-- resolve_entity_id_by_repo, which had no callers (the GitHub sync-source it was built
-- for was never enabled and `lib/github.ts` has none either). Dropped below.
-- -------------------------------------------------------------

create or replace function public.resolve_github_installation(p_installation_id bigint)
returns jsonb
language sql
security definer
set search_path = ''
stable
as $$
  select jsonb_build_object(
    'entity_id', gi.entity_id,
    'installation_row_id', gi.id,
    'status', gi.status,
    'repository_selection', gi.repository_selection
  )
  from public.github_installations gi
  where gi.installation_id = p_installation_id;
$$;

revoke execute on function public.resolve_github_installation(bigint) from public;
revoke execute on function public.resolve_github_installation(bigint) from anon;
revoke execute on function public.resolve_github_installation(bigint) from authenticated;
grant execute on function public.resolve_github_installation(bigint) to bot_service;

-- The function this one replaces. Dormant since the init schema: the GitHub sync-source
-- it bootstrapped was never enabled, and nothing in the app has ever called it.
drop function if exists public.resolve_entity_id_by_repo(text, text);

-- -------------------------------------------------------------
-- 2b. The same hardening for the connect-flow tables
--
-- github_installations, repo_links and github_connect_invites are currently protected by
-- their policy predicates alone, with Supabase's default DML grants still in place for
-- `anon` and `authenticated`. That holds today — the predicates are false without an entity
-- context, and the dashboard reaches these tables only through SECURITY DEFINER functions,
-- which run as the function owner and do not consult the caller's table privileges. But it
-- leaves a single policy typo between a browser key and tenant data, which is what the
-- delivery table nearly demonstrated. Revoking costs nothing and removes that coupling.
-- -------------------------------------------------------------

revoke all on public.github_installations from public;
revoke all on public.github_installations from anon;
revoke all on public.github_installations from authenticated;

revoke all on public.repo_links from public;
revoke all on public.repo_links from anon;
revoke all on public.repo_links from authenticated;

revoke all on public.github_connect_invites from public;
revoke all on public.github_connect_invites from anon;
revoke all on public.github_connect_invites from authenticated;

-- bot_service keeps what the earlier migrations granted it; the revokes above name only
-- the browser-facing roles.

-- -------------------------------------------------------------
-- 3. Invariant note (see init_schema section 4, as amended by the bot-cutover migration)
--
-- Secret-bearing bypass functions, unchanged at two: get_current_entity_secret,
-- get_current_bot_secret.
-- Non-secret bootstrap resolvers, unchanged at three: resolve_entity_id_by_slug,
-- resolve_entity_id_by_chat, and now resolve_github_installation in place of the dropped
-- resolve_entity_id_by_repo.
-- -------------------------------------------------------------
