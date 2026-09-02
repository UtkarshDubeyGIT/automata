-- Mutable editor drafts keep autosave out of the immutable publication log.
-- Runtime triggers continue to read workflow_versions.published_version_id.
alter table public.workflows
  add column if not exists draft_graph jsonb,
  add column if not exists draft_positions jsonb not null default '{}'::jsonb,
  add column if not exists draft_revision bigint not null default 0,
  add column if not exists draft_updated_by uuid references auth.users(id) on delete set null;

update public.workflows as workflow
   set draft_graph = version.graph
  from public.workflow_versions as version
 where version.id = coalesce(workflow.draft_version_id, workflow.published_version_id)
   and workflow.draft_graph is null;

alter table public.workflows
  add constraint workflows_draft_graph_object
  check (draft_graph is null or jsonb_typeof(draft_graph) = 'object'),
  add constraint workflows_draft_positions_object
  check (jsonb_typeof(draft_positions) = 'object');
