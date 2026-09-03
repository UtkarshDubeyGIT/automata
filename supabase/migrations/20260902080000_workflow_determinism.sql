-- Deterministic workflow execution: trigger_state, job_locks table, credit_ledger idem_key, config/draft_config support.
alter table public.workflows
  add column if not exists trigger_state jsonb,
  add column if not exists config jsonb,
  add column if not exists draft_config jsonb;

create table if not exists public.job_locks (
  name text primary key,
  claimed_at timestamptz not null default now(),
  claimed_by text
);

alter table public.job_locks enable row level security;

alter table public.credit_ledger
  add column if not exists idem_key text;

create unique index if not exists credit_ledger_workspace_idem_key_idx
  on public.credit_ledger (workspace_id, idem_key)
  where idem_key is not null;
