-- Migration: update_context_doc — content-only edits, and the rename race
-- Created At: 2026-10-28
--
-- Two defects in update_context_doc as 20261027000000_context_doc_crud.sql shipped it. That file is
-- already applied to production, so it is left untouched and this migration replaces the function.
--
-- 1. A content-only edit was refused when the scope already held a duplicate name. The
--    duplicate_doc_name self-join ran on every call, whether or not p_name differed from the row's
--    current display_name. Two documents in one scope named 'dup' and 'Dup' — unreachable through
--    the dashboard, which checks names client-side, but reachable through /push from a chat or
--    manual SQL — made editing either one's *content* fail, because the check found the sibling
--    whose folded name matched the name the caller was keeping. The check now runs only when the
--    normalized name actually changes, so an edit can never be blocked by a clash it is not making.
--    A rename, including one that only changes case, is still checked: taking a name a sibling
--    already folds to stays a duplicate_doc_name.
--
-- 2. Two concurrent renames to the same free name could both succeed. update_context_doc took
--    `for update of c` on its own row only, which stops two writers racing on one document but not
--    two writers racing for one *name*: each read the scope, saw the name free, and wrote. The
--    uniqueness check is now made under the same per-scope advisory lock create_context_doc and
--    save_managed_context take, so a create and a rename competing for one name serialize and the
--    loser gets duplicate_doc_name.
--
--    Which scopes to lock: a document is bound to a scope by manifest_entries, and nothing stops it
--    being bound to several (entity-wide and one group, say). Its name has to stay unique in every
--    scope it is bound to, so this locks the key of EVERY bound scope rather than gating on the
--    entity alone — gating on the entity would not serialize against create_context_doc, which keys
--    its lock per (entity, group) and would still be free to create the same name in one group
--    while a rename in that group was checking. The keys are taken in hash order so two renames
--    cannot deadlock against each other, and the row lock is already held by then: no transaction
--    ever holds one of these advisory keys while waiting for a doc_cache row, so there is no cycle
--    with create_context_doc or save_managed_context, which take a single key each.
--
--    A topic binding is folded onto its group's key (create_context_doc never creates at topic
--    scope, so there is no finer key to share). That is coarser than it needs to be — two renames
--    in different topics of one group serialize — and correct.
--
-- Idempotent: create or replace + grants only. No data is modified at apply time.
-- Rollback: re-apply 20261027000000_context_doc_crud.sql, which restores the previous definition.

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
  v_current_name text;
  v_current timestamptz;
  v_updated timestamptz;
  v_scope record;
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

  select c.display_name, c.synced_at into v_current_name, v_current
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

  -- Only a rename can collide. Checking an unchanged name would re-report a duplicate that was
  -- already there (see note 1 above) and refuse an edit that is not creating it.
  if v_name is distinct from v_current_name then
    -- Every scope this document is bound to, in hash order: see note 2 above.
    for v_scope in
      select distinct hashtextextended(p_entity::text || ':' || coalesce(m.group_id::text, 'entity'), 0) as lock_key
      from public.manifest_entries m
      where m.entity_id = p_entity
        and m.doc_id = p_doc
      order by lock_key
    loop
      perform pg_advisory_xact_lock(v_scope.lock_key);
    end loop;

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
