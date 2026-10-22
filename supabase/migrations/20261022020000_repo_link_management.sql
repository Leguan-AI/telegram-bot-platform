-- Migration: 20261022020000_repo_link_management.sql
-- Linking repositories to groups and topics (#21 §3, §3a DB side)
--
-- Builds on 20261022010000_github_app_connect.sql. Idempotent throughout
-- (AGENTS.md rule 5): create or replace function / drop function if exists first where a
-- return type changes.

-- -------------------------------------------------------------
-- 1. Two more invariants on every repo_links write
--
-- Replaces enforce_repo_link_invariants() from the connect migration, adding the scope
-- checks the foreign keys cannot express: `group_id` and `thread_id` are FKs to their own
-- tables, so nothing stopped a row from naming this entity while pointing at *another*
-- entity's group, or at a thread from a different group. The isolation policy only looks
-- at entity_id, so it would not catch either.
--
-- Enforced in the trigger rather than in the RPCs below, so it covers every writer —
-- including the /repos chat path (§3a), which lands in a later change.
-- -------------------------------------------------------------

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

  -- The group must belong to this entity.
  if new.group_id is not null and not exists (
    select 1 from public.groups g
    where g.id = new.group_id and g.entity_id = new.entity_id
  ) then
    raise exception 'repo_link_group_foreign' using errcode = '23514';
  end if;

  -- The topic must belong to that group (and so to this entity).
  if new.thread_id is not null and not exists (
    select 1 from public.threads t
    where t.id = new.thread_id
      and t.group_id = new.group_id
      and t.entity_id = new.entity_id
  ) then
    raise exception 'repo_link_thread_foreign' using errcode = '23514';
  end if;

  if new.thread_id is null then
    return new;
  end if;

  -- Pins narrow, never widen: the repo must already be linked at group or entity level.
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

-- -------------------------------------------------------------
-- 2. Reading the links (/manage)
-- -------------------------------------------------------------

-- Every link in the entity, with the scope names the browser cannot read for itself
-- (groups and threads are tenant-isolated). Repository *names* are not stored — the
-- picker route fetches those from GitHub (§3).
create or replace function public.list_repo_links(p_entity uuid)
returns table (
  id                   uuid,
  repo_id              bigint,
  group_id             uuid,
  group_name           text,
  telegram_chat_id     bigint,
  thread_id            uuid,
  thread_name          text,
  telegram_thread_id   bigint,
  linked_by_profile_id uuid,
  linked_by_tg_user_id bigint,
  created_at           timestamptz
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
  select rl.id, rl.repo_id,
         rl.group_id, g.display_name, g.telegram_chat_id,
         rl.thread_id, t.name, t.telegram_thread_id,
         rl.linked_by_profile_id, rl.linked_by_tg_user_id, rl.created_at
  from public.repo_links rl
  left join public.groups g on g.id = rl.group_id
  left join public.threads t on t.id = rl.thread_id
  where rl.entity_id = p_entity
  order by rl.group_id nulls first, rl.thread_id nulls first, rl.repo_id;
end;
$$;

revoke execute on function public.list_repo_links(uuid) from public;
revoke execute on function public.list_repo_links(uuid) from anon;
revoke execute on function public.list_repo_links(uuid) from bot_service;
grant execute on function public.list_repo_links(uuid) to authenticated;


-- -------------------------------------------------------------
-- 3. Writing the links (the save endpoint)
--
-- bot_service only, and NOT callable from the browser: the route has to check with GitHub
-- that every submitted repository is currently in this entity's installation (#21 §3,
-- R2-B1), which the database cannot know. The route is therefore the gate for *which*
-- repositories, and this function is the gate for *who* and *where*: it re-checks the
-- acting profile's entity admin rights itself rather than trusting the caller, and the
-- trigger above re-checks the scope.
--
-- `p_repo_ids` replaces the link set at exactly one scope. Entity-level, group-level and
-- each topic pin are separate sets, so saving one never disturbs another — except that
-- removing a broader link prunes the pins it carried, which is the §3a invariant.
-- -------------------------------------------------------------

create or replace function public.set_repo_links(
  p_entity   uuid,
  p_profile  uuid,
  p_group    uuid,
  p_thread   uuid,
  p_repo_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_installation uuid;
  v_added int := 0;
  v_removed int := 0;
  v_total int;
begin
  if p_profile is null or not public.is_entity_admin_profile(p_entity, p_profile) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  if p_thread is not null and p_group is null then
    raise exception 'thread_without_group';
  end if;

  -- Only an active connection can hold links; the trigger enforces this per row, but
  -- failing here gives the caller one clear reason instead of a per-row constraint error.
  select gi.id into v_installation
  from public.github_installations gi
  where gi.entity_id = p_entity
    and gi.status = 'active';

  if not found then
    raise exception 'no_active_installation';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  -- Remove what is no longer selected at this exact scope.
  with removed as (
    delete from public.repo_links rl
    where rl.entity_id = p_entity
      and rl.group_id is not distinct from p_group
      and rl.thread_id is not distinct from p_thread
      and not (rl.repo_id = any (coalesce(p_repo_ids, '{}'::bigint[])))
    returning 1
  )
  select count(*) into v_removed from removed;

  -- Add what is new. The unique index (NULLS NOT DISTINCT) makes the conflict target
  -- exact, so a repeated save is a no-op rather than a duplicate.
  with added as (
    insert into public.repo_links (
      entity_id, github_installation_id, group_id, thread_id, repo_id, linked_by_profile_id
    )
    select p_entity, v_installation, p_group, p_thread, r, p_profile
    from unnest(coalesce(p_repo_ids, '{}'::bigint[])) as r
    on conflict (entity_id, group_id, thread_id, repo_id) do nothing
    returning 1
  )
  select count(*) into v_added from added;

  select count(*) into v_total
  from public.repo_links rl
  where rl.entity_id = p_entity
    and rl.group_id is not distinct from p_group
    and rl.thread_id is not distinct from p_thread;

  return jsonb_build_object('added', v_added, 'removed', v_removed, 'total', v_total);
end;
$$;

revoke execute on function public.set_repo_links(uuid, uuid, uuid, uuid, bigint[]) from public;
revoke execute on function public.set_repo_links(uuid, uuid, uuid, uuid, bigint[]) from anon;
revoke execute on function public.set_repo_links(uuid, uuid, uuid, uuid, bigint[]) from authenticated;
grant execute on function public.set_repo_links(uuid, uuid, uuid, uuid, bigint[]) to bot_service;


-- -------------------------------------------------------------
-- 4. The connection a server route may act on
--
-- The picker and save routes run as bot_service, before any tenant context exists, and
-- need the installation id plus an authorization decision for a profile that is not
-- auth.uid(). Granted to bot_service only; it answers nothing to a caller who is not an
-- admin of that entity, so it cannot be used to probe another tenant's installation.
-- -------------------------------------------------------------

create or replace function public.get_github_connection_for_admin(p_entity uuid, p_profile uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
begin
  if p_profile is null or not public.is_entity_admin_profile(p_entity, p_profile) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  select gi.* into v_row
  from public.github_installations gi
  where gi.entity_id = p_entity;

  if v_row.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'installation_id', v_row.installation_id,
    'account_login', v_row.account_login,
    'repository_selection', v_row.repository_selection,
    'status', v_row.status
  );
end;
$$;

revoke execute on function public.get_github_connection_for_admin(uuid, uuid) from public;
revoke execute on function public.get_github_connection_for_admin(uuid, uuid) from anon;
revoke execute on function public.get_github_connection_for_admin(uuid, uuid) from authenticated;
grant execute on function public.get_github_connection_for_admin(uuid, uuid) to bot_service;
