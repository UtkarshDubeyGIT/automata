create or replace function public.publish_workflow_draft(
  p_workflow_id uuid,
  p_base_revision bigint,
  p_graph jsonb,
  p_next_run_at timestamptz default null
) returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_workflow public.workflows%rowtype;
  v_version_id uuid;
  v_version integer;
begin
  select * into v_workflow
    from public.workflows
   where id = p_workflow_id
   for update;
  if not found then raise exception 'workflow_not_found' using errcode = 'P0002'; end if;
  if not private.has_workspace_role(v_workflow.workspace_id, array['owner','admin','member']::public.workspace_role[]) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_workflow.draft_revision <> p_base_revision then
    raise exception 'revision_conflict' using errcode = '40001';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
    from public.workflow_versions
   where workflow_id = p_workflow_id;
  insert into public.workflow_versions (
    workflow_id, workspace_id, version, graph, change_summary, created_by, published_at
  ) values (
    p_workflow_id, v_workflow.workspace_id, v_version, p_graph,
    'Published from visual editor', auth.uid(), now()
  ) returning id into v_version_id;

  update public.workflows
     set published_version_id = v_version_id,
         state = 'active',
         next_run_at = p_next_run_at
   where id = p_workflow_id;
  return v_version_id;
end;
$$;

revoke all on function public.publish_workflow_draft(uuid, bigint, jsonb, timestamptz) from public;
grant execute on function public.publish_workflow_draft(uuid, bigint, jsonb, timestamptz) to authenticated;
