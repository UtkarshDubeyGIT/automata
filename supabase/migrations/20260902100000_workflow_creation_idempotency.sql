-- One user-intended create must remain one workflow across double-clicks,
-- network retries, and a browser that never received the first response.
alter table public.workflows
  add column if not exists creation_key text;

create unique index if not exists workflows_workspace_creation_key_key
  on public.workflows (workspace_id, creation_key)
  where creation_key is not null;
