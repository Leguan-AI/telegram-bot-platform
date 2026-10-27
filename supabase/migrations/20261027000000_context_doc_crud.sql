-- Migration: Context document CRUD for the dashboard (many named documents per scope)
-- Created At: 2026-10-27
--
-- 20261022000000_dashboard_context_management.sql gave each scope exactly ONE dashboard-owned
-- document ('entity-context' / 'group-context'), edited in place through save_managed_context.
-- That made the dashboard's textarea an editor, not an "add a document" box: saving replaced the
-- scope's only document and uploading a file replaced the text that was already in it. Admins read
-- that as data loss, and there was no way to remove a document at all.
--
-- This migration adds the document-level operations the dashboard needs instead:
--   create_context_doc  — a new named document in a scope
--   update_context_doc  — rename and/or re-write one document, by id
--   delete_context_doc  — remove one document, by id
--   get_context_doc     — read one document, by id, for the editor
--
-- Scope is a property of the manifest entry, so update/delete/get work on any document bound to the
-- entity, whatever created it: dashboard, /push from a Telegram chat, or manual SQL. The bot's read
-- path (buildContext) already joins every manifest entry in scope, so several documents per scope
-- need no change there.
--
-- save_managed_context / get_managed_context are intentionally left in place. The documents they
-- created are ordinary documents to the functions below — listed, editable and deletable by name —
-- so nothing has to be migrated, and existing harnesses keep working.
--
-- Idempotent: create or replace + grants only. No data is modified at apply time.

-- ---------------------------------------------------------------------------------------------
-- 0. Shared name rules. A display_name reaches the model as <document path="..."> and an admin as a
--    row in the dashboard's list, so it must be a single clean line.
-- ---------------------------------------------------------------------------------------------
create or replace function public.normalize_context_doc_name(p_name text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  v_name := regexp_replace(coalesce(p_name, ''), '^\s+|\s+$', '', 'g');
  if v_name = '' then
    raise exception 'empty_name' using errcode = '22023';
  end if;
  if length(v_name) > 120 then
    raise exception 'name_too_long' using errcode = '22023';
  end if;
  -- No newlines, tabs or other control characters: one document, one line in the list.
  if v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  return v_name;
end;
$$;

revoke execute on function public.normalize_context_doc_name(text) from public, anon;
grant execute on function public.normalize_context_doc_name(text) to authenticated;


-- ---------------------------------------------------------------------------------------------
-- 1. create_context_doc: a new document at entity scope (p_group null) or one group's scope.
--    Topic documents are created from Telegram by /push; the dashboard edits and deletes them.
-- ---------------------------------------------------------------------------------------------
create or replace function public.create_context_doc(
  p_entity uuid,
  p_group uuid,
  p_name text,
  p_content text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_bytes constant integer := 262144; -- 256 KB, same cap as save_managed_context and /push
  v_name text;
  v_content text;
  v_doc_id uuid;
begin
  if not (
    public.is_entity_owner(p_entity)
    or public.has_active_auth(p_entity, 'admin')
    or public.has_active_auth(p_entity, 'editor')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  v_name := public.normalize_context_doc_name(p_name);

  v_content := regexp_replace(coalesce(p_content, ''), '^\s+|\s+$', '', 'g');
  if v_content = '' then
    raise exception 'empty_content' using errcode = '22023';
  end if;
  if octet_length(v_content) > v_max_bytes then
    raise exception 'content_too_large' using errcode = '22023';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  if p_group is not null and not exists (
    select 1 from public.groups g where g.id = p_group and g.entity_id = p_entity
  ) then
    raise exception 'group_not_in_entity' using errcode = '22023';
  end if;

  -- Same key as save_managed_context, so a legacy save and a create in one scope serialize together
  -- and two admins cannot both win a name that is free when each of them checks it.
  perform pg_advisory_xact_lock(hashtextextended(p_entity::text || ':' || coalesce(p_group::text, 'entity'), 0));

  if exists (
    select 1
    from public.manifest_entries m
    join public.doc_cache c on c.id = m.doc_id
    where m.entity_id = p_entity
      and m.group_id is not distinct from p_group
      and m.thread_id is null
      and lower(c.display_name) = lower(v_name)
  ) then
    raise exception 'duplicate_doc_name' using errcode = '22023';
  end if;

  insert into public.doc_cache (entity_id, display_name, content, source_type, source)
  values (
    p_entity,
    v_name,
    v_content,
    'manual',
    jsonb_build_object(
      'managed_by', 'dashboard',
      'scope', case when p_group is null then 'entity' else 'group' end,
      'created_by', auth.uid()::text,
      'edited_by', auth.uid()::text,
      'first_saved_at', now()
    )
  )
  returning id into v_doc_id;

  insert into public.manifest_entries (entity_id, group_id, thread_id, doc_id)
  values (p_entity, p_group, null, v_doc_id);

  return v_doc_id;
end;
$$;

revoke execute on function public.create_context_doc(uuid, uuid, text, text) from public, anon;
grant execute on function public.create_context_doc(uuid, uuid, text, text) to authenticated;


-- ---------------------------------------------------------------------------------------------
-- 2. get_context_doc: one document, for the editor. Readable by the owner or any active member,
--    matching list_context_docs — the list already shows every name and size.
-- ---------------------------------------------------------------------------------------------
create or replace function public.get_context_doc(p_entity uuid, p_doc uuid)
returns table (
  doc_id uuid,
  display_name text,
  content text,
  source_type text,
  managed boolean,
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
    c.content,
    c.source_type,
    coalesce(c.source->>'managed_by' = 'dashboard', false),
    c.synced_at
  from public.manifest_entries m
  join public.doc_cache c on c.id = m.doc_id
  where m.entity_id = p_entity
    and m.doc_id = p_doc
  limit 1;
end;
$$;

revoke execute on function public.get_context_doc(uuid, uuid) from public, anon;
grant execute on function public.get_context_doc(uuid, uuid) to authenticated;


-- ---------------------------------------------------------------------------------------------
-- 3. update_context_doc: rename and/or re-write one document, by id.
--
--    Works on any document bound to the entity, including one pushed from a Telegram chat: the
--    dashboard is the management plane, and an admin who can see a document can correct it.
--    source_type is left alone so the list keeps telling the truth about where a document came
--    from — and a later /push of the same message still overwrites it, as it always did.
--
--    Optimistic concurrency, as in save_managed_context: p_expected_updated_at must equal the value
--    the caller last read, or the save is refused with 'context_conflict'.
-- ---------------------------------------------------------------------------------------------
create or replace function public.update_context_doc(
  p_entity uuid,
  p_doc uuid,
  p_name text,
  p_content text,
  p_expected_updated_at timestamptz default null
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_max_bytes constant integer := 262144;
  v_name text;
  v_content text;
  v_current timestamptz;
  v_updated timestamptz;
begin
  if not (
    public.is_entity_owner(p_entity)
    or public.has_active_auth(p_entity, 'admin')
    or public.has_active_auth(p_entity, 'editor')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  v_name := public.normalize_context_doc_name(p_name);

  v_content := regexp_replace(coalesce(p_content, ''), '^\s+|\s+$', '', 'g');
  if v_content = '' then
    raise exception 'empty_content' using errcode = '22023';
  end if;
  if octet_length(v_content) > v_max_bytes then
    raise exception 'content_too_large' using errcode = '22023';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  select c.synced_at into v_current
  from public.manifest_entries m
  join public.doc_cache c on c.id = m.doc_id
  where m.entity_id = p_entity
    and m.doc_id = p_doc
  limit 1
  for update of c;

  if v_current is null then
    raise exception 'doc_not_found' using errcode = '22023';
  end if;

  -- Compared at millisecond precision: JS clients (Date) cannot round-trip Postgres' microseconds
  if date_trunc('milliseconds', p_expected_updated_at) is distinct from date_trunc('milliseconds', v_current) then
    raise exception 'context_conflict' using errcode = 'P0001';
  end if;

  -- A rename must stay unique in every scope this document is bound to.
  if exists (
    select 1
    from public.manifest_entries m_self
    join public.manifest_entries m_other
      on m_other.entity_id = m_self.entity_id
     and m_other.group_id is not distinct from m_self.group_id
     and m_other.thread_id is not distinct from m_self.thread_id
     and m_other.doc_id <> m_self.doc_id
    join public.doc_cache c_other on c_other.id = m_other.doc_id
    where m_self.entity_id = p_entity
      and m_self.doc_id = p_doc
      and lower(c_other.display_name) = lower(v_name)
  ) then
    raise exception 'duplicate_doc_name' using errcode = '22023';
  end if;

  update public.doc_cache
  set display_name = v_name,
      content = v_content,
      synced_at = clock_timestamp(),
      source = coalesce(source, '{}'::jsonb)
                 || jsonb_build_object('edited_by', auth.uid()::text, 'edited_in_dashboard', true)
  where id = p_doc
  returning synced_at into v_updated;

  return v_updated;
end;
$$;

revoke execute on function public.update_context_doc(uuid, uuid, text, text, timestamptz) from public, anon;
grant execute on function public.update_context_doc(uuid, uuid, text, text, timestamptz) to authenticated;


-- ---------------------------------------------------------------------------------------------
-- 4. delete_context_doc: remove one document, by id. manifest_entries.doc_id cascades, so the
--    binding goes with it and the bot stops seeing the document on its next answer.
--    Returns true when a row was removed, false when it had already gone.
-- ---------------------------------------------------------------------------------------------
create or replace function public.delete_context_doc(p_entity uuid, p_doc uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exists boolean;
begin
  if not (
    public.is_entity_owner(p_entity)
    or public.has_active_auth(p_entity, 'admin')
    or public.has_active_auth(p_entity, 'editor')
  ) then
    raise exception 'Access Denied' using errcode = '42501';
  end if;

  perform set_config('app.current_entity_id', p_entity::text, true);

  -- The manifest entry is what binds a document to this entity; doc_cache.entity_id alone would
  -- let a caller name a document that belongs to another tenant's manifest.
  select true into v_exists
  from public.manifest_entries m
  where m.entity_id = p_entity and m.doc_id = p_doc
  limit 1;

  if v_exists is null then
    return false;
  end if;

  delete from public.doc_cache c where c.id = p_doc and c.entity_id = p_entity;

  return true;
end;
$$;

revoke execute on function public.delete_context_doc(uuid, uuid) from public, anon;
grant execute on function public.delete_context_doc(uuid, uuid) to authenticated;
