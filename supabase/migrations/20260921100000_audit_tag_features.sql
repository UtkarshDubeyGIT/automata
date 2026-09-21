-- Audit-tag implementation foundations: build diagnostics, reviewed workspace
-- voice profiles, and durable report delivery attempts.

alter table public.workflow_builds
  add column if not exists correlation_id uuid not null default gen_random_uuid();

create index if not exists workflow_builds_correlation_idx
  on public.workflow_builds (workspace_id, correlation_id);

create table if not exists public.workflow_build_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  event_key text not null,
  event_type text not null,
  level text not null default 'info' check (level in ('info', 'warn', 'error')),
  stage text not null,
  correlation_id uuid,
  build_job_id uuid references public.workflow_builds(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  attempt integer,
  duration_ms integer,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, event_key, event_type),
  check (char_length(event_key) between 1 and 300),
  check (char_length(event_type) between 1 and 100),
  check (attempt is null or attempt >= 0),
  check (duration_ms is null or duration_ms >= 0),
  check (jsonb_typeof(metadata) = 'object')
);

create index if not exists workflow_build_events_workspace_time_idx
  on public.workflow_build_events (workspace_id, created_at desc);
create index if not exists workflow_build_events_job_time_idx
  on public.workflow_build_events (build_job_id, created_at desc);

alter table public.workflow_build_events enable row level security;
revoke all on public.workflow_build_events from anon, authenticated;
grant select on public.workflow_build_events to authenticated;
grant all on public.workflow_build_events to service_role;
drop policy if exists "workflow diagnostics read admins" on public.workflow_build_events;
create policy "workflow diagnostics read admins"
  on public.workflow_build_events for select to authenticated
  using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create table if not exists public.workspace_brand_voice_profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null,
  status text not null default 'candidate' check (status in ('candidate', 'accepted', 'disabled', 'deleted')),
  guidance text not null check (char_length(guidance) between 1 and 4000),
  confidence numeric(4,3),
  source_refs jsonb not null default '[]'::jsonb,
  sample_window_start date not null,
  sample_window_end date not null,
  sample_count integer not null default 0 check (sample_count between 0 and 100),
  approved_by uuid references auth.users(id) on delete set null,
  approved_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, version),
  check (sample_window_start <= sample_window_end),
  check (confidence is null or (confidence >= 0 and confidence <= 1)),
  check (jsonb_typeof(source_refs) = 'array')
);

create unique index if not exists workspace_brand_voice_one_accepted_idx
  on public.workspace_brand_voice_profiles (workspace_id)
  where status = 'accepted';
create index if not exists workspace_brand_voice_workspace_idx
  on public.workspace_brand_voice_profiles (workspace_id, version desc);
drop trigger if exists workspace_brand_voice_touch_updated on public.workspace_brand_voice_profiles;
create trigger workspace_brand_voice_touch_updated
  before update on public.workspace_brand_voice_profiles
  for each row execute function private.touch_updated_at();

alter table public.workspace_brand_voice_profiles enable row level security;
revoke all on public.workspace_brand_voice_profiles from anon, authenticated;
grant select, insert, update, delete on public.workspace_brand_voice_profiles to authenticated;
grant all on public.workspace_brand_voice_profiles to service_role;
drop policy if exists "brand voice read" on public.workspace_brand_voice_profiles;
create policy "brand voice read"
  on public.workspace_brand_voice_profiles for select to authenticated
  using (
    status = 'accepted'
    or private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])
  );
drop policy if exists "brand voice manage admins" on public.workspace_brand_voice_profiles;
create policy "brand voice manage admins"
  on public.workspace_brand_voice_profiles for all to authenticated
  using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
  with check (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create table if not exists public.workflow_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  workflow_run_id uuid,
  step_id text not null,
  destination_account_id text not null,
  recipient text not null,
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'definitive_failure', 'unknown')),
  provider_receipt_id text,
  error_code text,
  attempt integer not null default 1 check (attempt > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(payload) = 'object')
);

create index if not exists workflow_report_deliveries_workspace_idx
  on public.workflow_report_deliveries (workspace_id, created_at desc);
create index if not exists workflow_report_deliveries_unknown_idx
  on public.workflow_report_deliveries (workspace_id, created_at desc)
  where status = 'unknown';

alter table public.workflow_report_deliveries enable row level security;
revoke all on public.workflow_report_deliveries from anon, authenticated;
grant select on public.workflow_report_deliveries to authenticated;
grant all on public.workflow_report_deliveries to service_role;
drop policy if exists "report delivery read admins" on public.workflow_report_deliveries;
create policy "report delivery read admins"
  on public.workflow_report_deliveries for select to authenticated
  using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create or replace function public.purge_workflow_build_events(p_before timestamptz default now() - interval '30 days')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare removed integer;
begin
  delete from public.workflow_build_events where created_at < p_before;
  get diagnostics removed = row_count;
  return removed;
end;
$$;
revoke all on function public.purge_workflow_build_events(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_workflow_build_events(timestamptz) to service_role;
