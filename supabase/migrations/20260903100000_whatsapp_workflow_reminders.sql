-- Workflow-owned WhatsApp profiles and durable delivery outbox.

create table if not exists public.whatsapp_profiles (
  user_id              uuid primary key references auth.users (id) on delete cascade,
  workspace_id         uuid not null references public.workspaces (id) on delete cascade,
  phone_e164           text not null,
  verified_at          timestamptz,
  consented_at         timestamptz,
  consent_source       text,
  locale               text not null default 'en',
  timezone             text not null default 'UTC',
  enabled              boolean not null default false,
  workflow_reminders   boolean not null default false,
  general_reminders    boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint whatsapp_profiles_phone_e164 check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  unique (workspace_id, phone_e164)
);
create index if not exists whatsapp_profiles_workspace_idx
  on public.whatsapp_profiles (workspace_id);

create table if not exists public.message_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  user_id             uuid not null references auth.users (id) on delete cascade,
  workflow_id         uuid references public.workflows (id) on delete set null,
  workflow_run_id     uuid references public.workflow_runs (id) on delete set null,
  step_id             text,
  kind                text not null default 'workflow_summary',
  recipient_e164      text not null,
  body                text not null,
  template_sid        text,
  rendered_variables  jsonb not null default '{}'::jsonb,
  idempotency_key     text not null unique,
  twilio_message_sid  text unique,
  attempt_count       integer not null default 0,
  status              text not null default 'pending',
  error_code          text,
  error_message       text,
  next_attempt_at     timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint message_deliveries_recipient_e164 check (recipient_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  constraint message_deliveries_status check (status in (
    'pending', 'processing', 'retry', 'queued', 'sent', 'delivered', 'read',
    'undelivered', 'failed', 'simulated', 'skipped'
  )),
  constraint message_deliveries_attempt_count check (attempt_count >= 0)
);
create index if not exists message_deliveries_due_idx
  on public.message_deliveries (status, next_attempt_at);
create index if not exists message_deliveries_run_idx
  on public.message_deliveries (workflow_run_id);

alter table public.whatsapp_profiles enable row level security;
alter table public.message_deliveries enable row level security;

drop policy if exists "ws access" on public.whatsapp_profiles;
create policy "ws access" on public.whatsapp_profiles
  for all using (public.owns_workspace(workspace_id))
  with check (public.owns_workspace(workspace_id));

drop policy if exists "ws read" on public.message_deliveries;
create policy "ws read" on public.message_deliveries
  for select using (public.owns_workspace(workspace_id));
