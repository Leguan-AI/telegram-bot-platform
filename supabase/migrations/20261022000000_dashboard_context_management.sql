-- Migration: Dashboard context management (entity-wide and group-wide documents)
-- Created At: 2026-10-22
--
-- The dashboard role (`authenticated`) has no RLS path to doc_cache / manifest_entries (those tables are
-- tenant-isolated on app.current_entity_id, which only the bot connection sets). Same pattern as
-- list_entity_groups / mint_link_token: SECURITY DEFINER functions that authorize the caller against
-- authorizations / entity ownership, then set the tenant context transaction-locally.
--
-- Model: per scope (entity-wide, or one group) the dashboard owns exactly ONE document, tagged
-- doc_cache.source = {"managed_by": "dashboard", ...}. Documents added by /push or manual SQL are never
-- touched by save_managed_context; list_context_docs shows them read-only.
--
-- Idempotent: create or replace + grants only. No data is modified at apply time.

-- 1. list_context_docs: every document bound to the entity, with its scope (read: owner or any active member)
create or replace function public.list_context_docs(p_entity uuid)
returns table (
  doc_id uuid,
  display_name text,
  scope text,
  group_id uuid,
  group_name text,
  thread_name text,
  source_type text,
  managed boolean,
  size_bytes integer,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_entity_owner(p_entity) or public.has_active_auth(p_entity)) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  return query
  select
    c.id,
    c.display_name,
    case when m.thread_id is not null then 'topic'
         when m.group_id is not null then 'group'
         else 'entity' end,
    m.group_id,
    g.display_name,
    t.name,
    c.source_type,
    coalesce(c.source->>'managed_by' = 'dashboard', false),
    octet_length(c.content),
    c.synced_at
  from public.manifest_entries m
  join public.doc_cache c on c.id = m.doc_id
  left join public.groups g on g.id = m.group_id
  left join public.threads t on t.id = m.thread_id
  where m.entity_id = p_entity
  order by
    case when m.group_id is null then 0 else 1 end,
    g.display_name nulls first,
    case when m.thread_id is null then 0 else 1 end,
    c.display_name;
end;
$$;

revoke execute on function public.list_context_docs(uuid) from public, anon;
grant execute on function public.list_context_docs(uuid) to authenticated;


-- 2. get_managed_context: the dashboard-managed document for a scope (p_group null = entity-wide).
--    Returns zero rows if none has been saved yet.
create or replace function public.get_managed_context(p_entity uuid, p_group uuid default null)
returns table (
  doc_id uuid,
  content text,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not (public.is_entity_owner(p_entity) or public.has_active_auth(p_entity)) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  if p_group is not null and not exists (
    select 1 from public.groups g where g.id = p_group and g.entity_id = p_entity
  ) then
    raise exception 'group_not_in_entity' using errcode = '22023';
  end if;

  return query
  select c.id, c.content, c.synced_at
  from public.manifest_entries m
  join public.doc_cache c on c.id = m.doc_id
  where m.entity_id = p_entity
    and m.group_id is not distinct from p_group
    and m.thread_id is null
    and c.source_type = 'manual'
    and c.source->>'managed_by' = 'dashboard'
  limit 1;
end;
$$;

revoke execute on function public.get_managed_context(uuid, uuid) from public, anon;
grant execute on function public.get_managed_context(uuid, uuid) to authenticated;


-- 3. save_managed_context: create or update the dashboard-managed document for a scope.
--    Write access: owner, admin or editor. Optimistic concurrency: p_expected_updated_at must equal the
--    value last returned by get_managed_context / this function (null when the caller saw no document),
--    otherwise the save is refused with 'context_conflict' so two editors never silently overwrite each other.
--    Returns the new updated_at.
create or replace function public.save_managed_context(
  p_entity uuid,
  p_group uuid,
  p_content text,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_bytes constant integer := 262144; -- 256 KB, same cap as /push file attachments
  v_content text;
  v_doc_id uuid;
  v_current timestamptz;
  v_scope text;
  v_new_doc uuid;
  v_updated timestamptz;
begin
  if not (
    public.is_entity_owner(p_entity)
    or public.has_active_auth(p_entity, 'admin')
    or public.has_active_auth(p_entity, 'editor')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  -- Trim all surrounding whitespace (btrim alone only strips spaces, not newlines/tabs)
  v_content := regexp_replace(coalesce(p_content, ''), '^\s+|\s+$', '', 'g');
  if v_content = '' then
    raise exception 'empty_content' using errcode = '22023';
  end if;
  if octet_length(v_content) > v_max_bytes then
    raise exception 'content_too_large' using errcode = '22023';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  -- Entity-consistency check: a group can only be written for its own entity
  if p_group is not null and not exists (
    select 1 from public.groups g where g.id = p_group and g.entity_id = p_entity
  ) then
    raise exception 'group_not_in_entity' using errcode = '22023';
  end if;

  v_scope := case when p_group is null then 'entity' else 'group' end;

  -- Serialize saves per scope so two concurrent first-saves cannot create duplicate managed documents
  perform pg_advisory_xact_lock(hashtextextended(p_entity::text || ':' || coalesce(p_group::text, 'entity'), 0));

  select c.id, c.synced_at into v_doc_id, v_current
  from public.manifest_entries m
  join public.doc_cache c on c.id = m.doc_id
  where m.entity_id = p_entity
    and m.group_id is not distinct from p_group
    and m.thread_id is null
    and c.source_type = 'manual'
    and c.source->>'managed_by' = 'dashboard'
  limit 1
  for update of c;

  if v_doc_id is null then
    if p_expected_updated_at is not null then
      raise exception 'context_conflict' using errcode = 'P0001';
    end if;

    insert into public.doc_cache (entity_id, display_name, content, source_type, source)
    values (
      p_entity,
      case when p_group is null then 'entity-context' else 'group-context' end,
      v_content,
      'manual',
      jsonb_build_object(
        'managed_by', 'dashboard',
        'scope', v_scope,
        'edited_by', auth.uid()::text,
        'first_saved_at', now()
      )
    )
    returning id, synced_at into v_new_doc, v_updated;

    insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id)
    values (p_entity, p_group, null, v_new_doc);

    return v_updated;
  end if;

  -- Compared at millisecond precision: JS clients (Date) cannot round-trip Postgres' microseconds
  if date_trunc('milliseconds', p_expected_updated_at) is distinct from date_trunc('milliseconds', v_current) then
    raise exception 'context_conflict' using errcode = 'P0001';
  end if;

  update public.doc_cache
  set content = v_content,
      synced_at = clock_timestamp(),
      source = coalesce(source, '{}'::jsonb) || jsonb_build_object('edited_by', auth.uid()::text)
  where id = v_doc_id
  returning synced_at into v_updated;

  return v_updated;
end;
$$;

revoke execute on function public.save_managed_context(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function public.save_managed_context(uuid, uuid, text, timestamptz) to authenticated;
