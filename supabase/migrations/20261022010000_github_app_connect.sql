-- Migration: 20261022010000_github_app_connect.sql
-- GitHub App connect flow: installations, repo links, connect invites (#21 §2, §3 DB notes)
--
-- Idempotent throughout (AGENTS.md rule 5): create table if not exists / create index
-- if not exists / create or replace function / drop policy-trigger if exists.

-- -------------------------------------------------------------
-- 1. Tables
-- -------------------------------------------------------------

-- One GitHub App installation (one org or personal account) per entity (#21 §2c).
-- Nothing secret is stored here: installation_id is a grant reference, not a credential.
create table if not exists public.github_installations (
  id                          uuid primary key default gen_random_uuid(),
  entity_id                   uuid not null references public.entities(id) on delete cascade,
  installation_id             bigint not null unique,                 -- GitHub's numeric installation id
  account_id                  bigint not null,                        -- numeric id of the org/user the App is installed on
  account_login               text not null,                          -- display only; renames are expected
  account_type                text not null check (account_type in ('User', 'Organization')),
  repository_selection        text not null check (repository_selection in ('all', 'selected')),
  status                      text not null check (status in ('pending_confirmation', 'active', 'suspended')),
  connected_by_github_user_id bigint,                                 -- the GitHub owner who authorized
  connected_by_github_login   text,
  connected_by_profile_id     uuid references public.profiles(id) on delete set null,  -- direct flow: the /manage admin
  invited_by_profile_id       uuid references public.profiles(id) on delete set null,  -- invite flow: the issuing admin
  confirmed_by_profile_id     uuid references public.profiles(id) on delete set null,  -- invite flow: the confirming admin
  confirmed_at                timestamptz,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  -- v1: one installation per entity. Also the "slot" a pending_confirmation row holds.
  unique (entity_id)
);

-- Repo links mirror manifest_entries scoping: entity-level (both null), group-level
-- (group_id set) and topic pin (group_id + thread_id set). A pin can only narrow —
-- enforced by the trigger in section 4, since a CHECK cannot reference other rows.
create table if not exists public.repo_links (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references public.entities(id) on delete cascade,
  -- FK to the installation ROW, not GitHub's numeric installation_id
  github_installation_id uuid not null references public.github_installations(id) on delete cascade,
  group_id              uuid references public.groups(id) on delete cascade,
  thread_id             uuid references public.threads(id) on delete cascade,
  repo_id               bigint not null,                              -- numeric GitHub repository id, never owner/name
  linked_by_profile_id  uuid references public.profiles(id) on delete set null,  -- /manage user who linked or pinned
  linked_by_tg_user_id  bigint,                                       -- Telegram user who pinned (chat path)
  created_at            timestamptz not null default now(),
  -- A topic pin is always inside a group; entity-level links have neither.
  constraint repo_links_scope_shape check (thread_id is null or group_id is not null)
);

-- NULLS NOT DISTINCT so (entity, NULL, NULL, repo) can't be duplicated (#21 §3 DB notes).
create unique index if not exists repo_links_scope_uniq
  on public.repo_links (entity_id, group_id, thread_id, repo_id) nulls not distinct;

-- Connect tokens. Two kinds, one table, one consume path:
--   'direct' — the short-lived OAuth `state` for §2a, bound to entity + /manage admin;
--   'invite' — the 24 h connect-invite link for §2b, shown once, revocable.
-- Stored hashed (sha256 hex), like link_tokens.token_hash.
--
-- Both are bearer tokens: whoever holds one, and can prove GitHub ownership, completes
-- that entity's connection. 'direct' therefore gets the short 10-minute life, because it
-- skips the confirmation step on the premise that the admin who minted it is the GitHub
-- owner themselves; 'invite' gets 24 hours and lands as pending_confirmation, so a
-- forwarded or leaked link cannot silently occupy the entity's slot.
create table if not exists public.github_connect_invites (
  id                          uuid primary key default gen_random_uuid(),
  entity_id                   uuid not null references public.entities(id) on delete cascade,
  kind                        text not null check (kind in ('direct', 'invite')),
  token_hash                  text not null unique,
  issued_by                   uuid not null references public.profiles(id) on delete cascade,
  expires_at                  timestamptz not null,
  consumed_at                 timestamptz,
  revoked_at                  timestamptz,
  completed_by_github_user_id bigint,
  completed_by_github_login   text,
  installation_id             bigint,                                 -- the installation this token produced (audit)
  created_at                  timestamptz not null default now()
);

-- -------------------------------------------------------------
-- 2. Indexes
-- -------------------------------------------------------------

create index if not exists github_installations_entity_idx on public.github_installations (entity_id);
create index if not exists repo_links_entity_scope_idx on public.repo_links (entity_id, group_id, thread_id);
create index if not exists repo_links_installation_idx on public.repo_links (github_installation_id);
create index if not exists repo_links_repo_idx on public.repo_links (entity_id, repo_id);
create index if not exists github_connect_invites_entity_idx on public.github_connect_invites (entity_id);
create index if not exists github_connect_invites_expires_idx on public.github_connect_invites (expires_at);

-- -------------------------------------------------------------
-- 3. Row-Level Security (enabled AND forced, matching the existing tables)
-- -------------------------------------------------------------

alter table public.github_installations enable row level security;
alter table public.github_installations force row level security;
alter table public.repo_links enable row level security;
alter table public.repo_links force row level security;
alter table public.github_connect_invites enable row level security;
alter table public.github_connect_invites force row level security;

-- Permissive tenant-isolation policies, identical in shape to group_isolation /
-- model_call_isolation. /manage reaches these tables only through the SECURITY DEFINER
-- functions in section 5, which set app.current_entity_id after an authz check.
drop policy if exists github_installation_isolation on public.github_installations;
create policy github_installation_isolation on public.github_installations
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

drop policy if exists repo_link_isolation on public.repo_links;
create policy repo_link_isolation on public.repo_links
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

drop policy if exists github_connect_invite_isolation on public.github_connect_invites;
create policy github_connect_invite_isolation on public.github_connect_invites
  using (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid)
  with check (entity_id = nullif(current_setting('app.current_entity_id', true), '')::uuid);

-- bot_service reads installations and links at answer time.
grant select, insert, update, delete on public.github_installations to bot_service;
grant select, insert, update, delete on public.repo_links to bot_service;

-- Connect tokens are management-plane, like link_tokens: bot_service touches them only
-- through the SECURITY DEFINER functions below, never the table.
revoke all privileges on public.github_connect_invites from bot_service;

-- -------------------------------------------------------------
-- 4. Triggers
-- -------------------------------------------------------------

-- updated_at bookkeeping for github_installations.
create or replace function public.touch_github_installation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists github_installations_touch on public.github_installations;
create trigger github_installations_touch
  before update on public.github_installations
  for each row execute function public.touch_github_installation();

-- Two invariants on every repo_links write (#21 §2b step 6, §3a):
--
--   1. the row's installation must be `active`. A connection awaiting an admin's
--      confirmation holds the entity's slot and nothing else, so nothing can be linked
--      to it; a suspended installation cannot gain links either;
--   2. a topic pin may only select a repo already linked at group or entity level. Pins
--      narrow, never widen. A CHECK constraint cannot express this, because it has to
--      look at other rows.
--
-- SECURITY INVOKER on purpose: the checks run under the caller's RLS, so a row the
-- caller cannot see cannot satisfy them — the failure mode is "write rejected", never
-- "write allowed on invisible evidence".
create or replace function public.enforce_repo_link_invariants()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Bookkeeping updates (an audit column, or a profile FK going to null when a /manage
  -- user is deleted) must not be re-validated: they change nothing about scope, and
  -- failing them would block the delete that triggered them.
  if tg_op = 'UPDATE'
     and new.github_installation_id is not distinct from old.github_installation_id
     and new.repo_id is not distinct from old.repo_id
     and new.group_id is not distinct from old.group_id
     and new.thread_id is not distinct from old.thread_id then
    return new;
  end if;

  if not exists (
    select 1
    from public.github_installations gi
    where gi.id = new.github_installation_id
      and gi.entity_id = new.entity_id
      and gi.status = 'active'
  ) then
    raise exception 'repo_link_installation_not_active' using errcode = '23514';
  end if;

  if new.thread_id is null then
    return new;
  end if;

  if not exists (
    select 1
    from public.repo_links rl
    where rl.entity_id = new.entity_id
      and rl.repo_id = new.repo_id
      and rl.thread_id is null
      and (rl.group_id is null or rl.group_id = new.group_id)
  ) then
    raise exception 'repo_pin_would_widen' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists repo_links_pin_narrows on public.repo_links;
drop trigger if exists repo_links_invariants on public.repo_links;
create trigger repo_links_invariants
  before insert or update on public.repo_links
  for each row execute function public.enforce_repo_link_invariants();

-- The same invariant from the other side: unlinking a group- or entity-level repo must
-- not leave a pin behind that still grants it. Pin deletions re-enter this trigger and
-- return immediately (old.thread_id is not null), so there is no recursion.
create or replace function public.prune_widowed_repo_pins()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.thread_id is not null then
    return null;
  end if;

  delete from public.repo_links p
  where p.entity_id = old.entity_id
    and p.repo_id = old.repo_id
    and p.thread_id is not null
    and not exists (
      select 1
      from public.repo_links b
      where b.entity_id = p.entity_id
        and b.repo_id = p.repo_id
        and b.thread_id is null
        and (b.group_id is null or b.group_id = p.group_id)
    );

  return null;
end;
$$;

drop trigger if exists repo_links_prune_pins on public.repo_links;
create trigger repo_links_prune_pins
  after delete on public.repo_links
  for each row execute function public.prune_widowed_repo_pins();

-- -------------------------------------------------------------
-- 5. Connect-flow functions
--
-- These follow the mint_link_token / consume_link_token split exactly:
--   * mint / list / revoke / confirm / reject / read  -> `authenticated`, each one
--     gated internally on is_entity_owner() or has_active_auth(..., 'admin');
--   * peek / complete (the callback's server-side path) -> `bot_service` ONLY,
--     revoked from public, anon and authenticated.
-- The callback runs before any tenant context exists and must look tokens and
-- installations up across tenants, so those two turn row_security off for the lookup
-- and restore it before writing, exactly as consume_link_token does.
-- -------------------------------------------------------------

-- Admin check for an arbitrary profile. Separate from has_active_auth, which keys off
-- auth.uid(): the invite path has to re-check the *issuer*, who is not the caller.
-- Granted to no role: callable only from the SECURITY DEFINER functions below, so it
-- cannot be used to probe who administers another entity.
create or replace function public.is_entity_admin_profile(p_entity uuid, p_profile uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1 from public.entities e
    where e.id = p_entity and e.owner_profile_id = p_profile
  ) or exists (
    select 1 from public.authorizations a
    where a.entity_id = p_entity
      and a.profile_id = p_profile
      and a.status = 'active'
      and a.role = 'admin'
  );
$$;

revoke execute on function public.is_entity_admin_profile(uuid, uuid) from public;
revoke execute on function public.is_entity_admin_profile(uuid, uuid) from authenticated;
revoke execute on function public.is_entity_admin_profile(uuid, uuid) from anon;
revoke execute on function public.is_entity_admin_profile(uuid, uuid) from bot_service;


-- Mint a connect token. 'direct' is the OAuth state for §2a (10 minutes); 'invite' is
-- the connect-invite link for §2b (24 hours). Returned once, stored only as a hash.
create or replace function public.mint_github_connect_token(p_entity uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_hash text;
  v_ttl interval;
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  if p_kind not in ('direct', 'invite') then
    raise exception 'invalid_kind';
  end if;

  v_ttl := case p_kind when 'direct' then interval '10 minutes' else interval '24 hours' end;

  -- 26 chars of Crockford base32 (130 bits). Same construction as mint_link_token, but
  -- longer: this one travels in a URL rather than being typed into a chat.
  select string_agg(
    substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
           (get_byte(b, i) & 31) + 1, 1), '')
  into v_code
  from (select extensions.gen_random_bytes(26) as b) g,
       generate_series(0, 25) as i;

  v_hash := encode(sha256(v_code::bytea), 'hex');

  insert into public.github_connect_invites (entity_id, kind, token_hash, issued_by, expires_at)
  values (p_entity, p_kind, v_hash, auth.uid(), now() + v_ttl);

  return v_code;
end;
$$;

grant execute on function public.mint_github_connect_token(uuid, text) to authenticated;


-- Pending invites for the /manage list. 'direct' states are plumbing, not invites, so
-- they are excluded.
create or replace function public.list_github_connect_invites(p_entity uuid)
returns table (
  id          uuid,
  issued_by   uuid,
  created_at  timestamptz,
  expires_at  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  return query
  select i.id, i.issued_by, i.created_at, i.expires_at
  from public.github_connect_invites i
  where i.entity_id = p_entity
    and i.kind = 'invite'
    and i.consumed_at is null
    and i.revoked_at is null
    and i.expires_at > now()
  order by i.created_at desc;
end;
$$;

grant execute on function public.list_github_connect_invites(uuid) to authenticated;


-- Revoke a pending invite. Scoped by entity as well as id so a guessed id from another
-- tenant cannot be revoked.
create or replace function public.revoke_github_connect_invite(p_entity uuid, p_invite uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  update public.github_connect_invites
  set revoked_at = now()
  where id = p_invite
    and entity_id = p_entity
    and consumed_at is null
    and revoked_at is null;

  if not found then
    raise exception 'invite_not_pending';
  end if;
end;
$$;

grant execute on function public.revoke_github_connect_invite(uuid, uuid) to authenticated;


-- The entity's connection, for the /manage GitHub tab.
create or replace function public.get_github_connection(p_entity uuid)
returns table (
  id                          uuid,
  installation_id             bigint,
  account_id                  bigint,
  account_login               text,
  account_type                text,
  repository_selection        text,
  status                      text,
  connected_by_github_login   text,
  connected_by_profile_id     uuid,
  invited_by_profile_id       uuid,
  confirmed_by_profile_id     uuid,
  confirmed_at                timestamptz,
  created_at                  timestamptz,
  updated_at                  timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  return query
  select g.id, g.installation_id, g.account_id, g.account_login, g.account_type,
         g.repository_selection, g.status, g.connected_by_github_login,
         g.connected_by_profile_id, g.invited_by_profile_id, g.confirmed_by_profile_id,
         g.confirmed_at, g.created_at, g.updated_at
  from public.github_installations g
  where g.entity_id = p_entity;
end;
$$;

grant execute on function public.get_github_connection(uuid) to authenticated;


-- §2b step 6: Confirm. Until this runs, no repos can be linked and no repo tools run.
create or replace function public.confirm_github_connection(p_entity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  update public.github_installations
  set status = 'active',
      confirmed_by_profile_id = auth.uid(),
      confirmed_at = now()
  where entity_id = p_entity
    and status = 'pending_confirmation';

  if not found then
    raise exception 'no_pending_connection';
  end if;
end;
$$;

grant execute on function public.confirm_github_connection(uuid) to authenticated;


-- §2b step 6: Reject. Removes the pending record and frees the entity's slot; the
-- installation stays unused on GitHub until its owner removes it. Links cascade, but a
-- pending connection can never have had any.
create or replace function public.reject_github_connection(p_entity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  delete from public.github_installations
  where entity_id = p_entity
    and status = 'pending_confirmation';

  if not found then
    raise exception 'no_pending_connection';
  end if;
end;
$$;

grant execute on function public.reject_github_connection(uuid) to authenticated;


-- Disconnect (§3 "Revocation is in the owners' hands"). Entity admins can hand the slot
-- back whichever status the connection is in; repo links and pins cascade. The
-- installation itself stays on GitHub until its owner removes it there.
create or replace function public.disconnect_github_connection(p_entity uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (
    public.is_entity_owner(p_entity) or
    public.has_active_auth(p_entity, 'admin')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  delete from public.github_installations
  where entity_id = p_entity;

  if not found then
    raise exception 'no_connection';
  end if;
end;
$$;

grant execute on function public.disconnect_github_connection(uuid) to authenticated;


-- Functions default to EXECUTE for PUBLIC, so the grants above on their own would also
-- leave them callable by anon and bot_service. Each one is gated internally on
-- auth.uid(), which is null for both, so they would answer "Access Denied" — but these
-- functions are the security boundary for repo access, so the reachable surface is
-- narrowed to `authenticated` explicitly rather than resting on that.
revoke execute on function public.mint_github_connect_token(uuid, text) from public;
revoke execute on function public.mint_github_connect_token(uuid, text) from anon;
revoke execute on function public.mint_github_connect_token(uuid, text) from bot_service;

revoke execute on function public.list_github_connect_invites(uuid) from public;
revoke execute on function public.list_github_connect_invites(uuid) from anon;
revoke execute on function public.list_github_connect_invites(uuid) from bot_service;

revoke execute on function public.revoke_github_connect_invite(uuid, uuid) from public;
revoke execute on function public.revoke_github_connect_invite(uuid, uuid) from anon;
revoke execute on function public.revoke_github_connect_invite(uuid, uuid) from bot_service;

revoke execute on function public.get_github_connection(uuid) from public;
revoke execute on function public.get_github_connection(uuid) from anon;
revoke execute on function public.get_github_connection(uuid) from bot_service;

revoke execute on function public.confirm_github_connection(uuid) from public;
revoke execute on function public.confirm_github_connection(uuid) from anon;
revoke execute on function public.confirm_github_connection(uuid) from bot_service;

revoke execute on function public.reject_github_connection(uuid) from public;
revoke execute on function public.reject_github_connection(uuid) from anon;
revoke execute on function public.reject_github_connection(uuid) from bot_service;

revoke execute on function public.disconnect_github_connection(uuid) from public;
revoke execute on function public.disconnect_github_connection(uuid) from anon;
revoke execute on function public.disconnect_github_connection(uuid) from bot_service;


-- -------------------------------------------------------------
-- 6. Callback-path functions (bot_service only)
--
-- Both return jsonb rather than a composite row: these bodies read and write
-- github_installations and github_connect_invites in the same statement block, and
-- `returns table` output names would shadow those tables' identically-named columns.
-- -------------------------------------------------------------

-- Landing page for a connect invite (§2b step 2). Reads only: the token is consumed by
-- complete_github_connect, after GitHub has proved ownership.
create or replace function public.peek_github_connect_invite(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
  v_entity_name text;
begin
  perform set_config('row_security', 'off', true);

  select i.* into v_invite
  from public.github_connect_invites i
  where i.token_hash = encode(sha256(p_code::bytea), 'hex')
    and i.kind = 'invite';

  if not found then
    perform set_config('row_security', 'on', true);
    raise exception 'invalid_token';
  end if;

  if v_invite.revoked_at is not null then
    perform set_config('row_security', 'on', true);
    raise exception 'revoked';
  end if;

  if v_invite.consumed_at is not null then
    perform set_config('row_security', 'on', true);
    raise exception 'already_consumed';
  end if;

  if v_invite.expires_at <= now() then
    perform set_config('row_security', 'on', true);
    raise exception 'expired';
  end if;

  -- A demoted issuer invalidates the invite before the invitee ever reaches GitHub.
  if not public.is_entity_admin_profile(v_invite.entity_id, v_invite.issued_by) then
    perform set_config('row_security', 'on', true);
    raise exception 'issuer_not_admin';
  end if;

  select e.display_name into v_entity_name
  from public.entities e
  where e.id = v_invite.entity_id;

  perform set_config('row_security', 'on', true);

  return jsonb_build_object(
    'entity_id', v_invite.entity_id,
    'entity_name', v_entity_name,
    'expires_at', v_invite.expires_at
  );
end;
$$;

revoke execute on function public.peek_github_connect_invite(text) from public;
revoke execute on function public.peek_github_connect_invite(text) from authenticated;
revoke execute on function public.peek_github_connect_invite(text) from anon;
grant execute on function public.peek_github_connect_invite(text) to bot_service;


-- The callback's single write (§2a step 4, §2b steps 4-5). Everything GitHub-derived
-- arrives as a parameter *after* the route has run the owner check; the entity comes
-- from the token and never from the request.
--
-- Outcomes: 'connected' (direct, active immediately), 'pending_confirmation' (invite,
-- awaiting an admin), 'already_connected' (same installation on the same entity — the
-- owner most likely just changed the repo selection).
-- Raises: invalid_token, revoked, already_consumed, expired, issuer_not_admin,
-- attached_elsewhere, entity_slot_taken.
create or replace function public.complete_github_connect(
  p_code                 text,
  p_installation_id      bigint,
  p_account_id           bigint,
  p_account_login        text,
  p_account_type         text,
  p_repository_selection text,
  p_github_user_id       bigint,
  p_github_login         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_invite record;
  v_existing record;
  v_slot record;
  v_entity_name text;
  v_status text;
  v_outcome text;
begin
  perform set_config('row_security', 'off', true);

  select i.* into v_invite
  from public.github_connect_invites i
  where i.token_hash = encode(sha256(p_code::bytea), 'hex')
  for update;

  if not found then
    perform set_config('row_security', 'on', true);
    raise exception 'invalid_token';
  end if;

  if v_invite.revoked_at is not null then
    perform set_config('row_security', 'on', true);
    raise exception 'revoked';
  end if;

  if v_invite.consumed_at is not null then
    perform set_config('row_security', 'on', true);
    raise exception 'already_consumed';
  end if;

  if v_invite.expires_at <= now() then
    perform set_config('row_security', 'on', true);
    raise exception 'expired';
  end if;

  if not public.is_entity_admin_profile(v_invite.entity_id, v_invite.issued_by) then
    perform set_config('row_security', 'on', true);
    raise exception 'issuer_not_admin';
  end if;

  -- Cross-tenant lookups: installation_id is unique platform-wide, so this is the only
  -- place that has to see other tenants' rows.
  select g.* into v_existing
  from public.github_installations g
  where g.installation_id = p_installation_id
  for update;

  select g.* into v_slot
  from public.github_installations g
  where g.entity_id = v_invite.entity_id
  for update;

  perform set_config('row_security', 'on', true);

  if v_existing.id is not null and v_existing.entity_id <> v_invite.entity_id then
    raise exception 'attached_elsewhere';
  end if;

  if v_existing.id is null and v_slot.id is not null then
    raise exception 'entity_slot_taken';
  end if;

  -- Writes run under the tenant's own RLS context, like consume_link_token.
  perform set_config('app.current_entity_id', v_invite.entity_id::text, true);

  if v_existing.id is not null then
    -- Already this entity's installation: refresh what GitHub just told us and leave the
    -- status alone (a pending connection stays pending).
    update public.github_installations g
    set account_id = p_account_id,
        account_login = p_account_login,
        account_type = p_account_type,
        repository_selection = p_repository_selection
    where g.id = v_existing.id;

    v_status := v_existing.status;
    v_outcome := 'already_connected';
  else
    v_status := case v_invite.kind when 'direct' then 'active' else 'pending_confirmation' end;
    v_outcome := case v_invite.kind when 'direct' then 'connected' else 'pending_confirmation' end;

    insert into public.github_installations (
      entity_id, installation_id, account_id, account_login, account_type,
      repository_selection, status,
      connected_by_github_user_id, connected_by_github_login,
      connected_by_profile_id, invited_by_profile_id
    )
    values (
      v_invite.entity_id, p_installation_id, p_account_id, p_account_login, p_account_type,
      p_repository_selection, v_status,
      p_github_user_id, p_github_login,
      case v_invite.kind when 'direct' then v_invite.issued_by else null end,
      case v_invite.kind when 'invite' then v_invite.issued_by else null end
    );
  end if;

  update public.github_connect_invites i
  set consumed_at = now(),
      completed_by_github_user_id = p_github_user_id,
      completed_by_github_login = p_github_login,
      installation_id = p_installation_id
  where i.id = v_invite.id;

  select e.display_name into v_entity_name
  from public.entities e
  where e.id = v_invite.entity_id;

  return jsonb_build_object(
    'entity_id', v_invite.entity_id,
    'entity_name', v_entity_name,
    'kind', v_invite.kind,
    'status', v_status,
    'outcome', v_outcome,
    'account_login', p_account_login,
    'repository_selection', p_repository_selection
  );
end;
$$;

revoke execute on function public.complete_github_connect(text, bigint, bigint, text, text, text, bigint, text) from public;
revoke execute on function public.complete_github_connect(text, bigint, bigint, text, text, text, bigint, text) from authenticated;
revoke execute on function public.complete_github_connect(text, bigint, bigint, text, text, text, bigint, text) from anon;
grant execute on function public.complete_github_connect(text, bigint, bigint, text, text, text, bigint, text) to bot_service;


-- -------------------------------------------------------------
-- 7. Invariant note (see init_schema section 4)
--
-- This migration adds no new RLS-bypass *resolver*. The functions above are capability
-- functions in the mint_link_token / consume_link_token mould: each one either checks the
-- caller's entity admin rights (authenticated) or is granted exclusively to bot_service
-- and keyed by a single-use token hash (peek / complete). is_entity_admin_profile is
-- granted to no role at all. The installation -> entity bootstrap resolver the webhook
-- route needs is NOT here; it belongs to the webhook work (#21 §4) and requires its own
-- security review.
-- -------------------------------------------------------------
