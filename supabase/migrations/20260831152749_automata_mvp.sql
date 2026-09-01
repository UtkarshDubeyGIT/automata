-- Automata MVP: multi-tenant workflow automation SaaS.
-- All product tables live in public for the Data API and are protected by
-- explicit grants plus workspace-aware row-level security.

create extension if not exists pgcrypto;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.workspace_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.plan_id as enum ('free', 'pro', 'team');
create type public.workflow_state as enum ('draft', 'active', 'paused', 'archived');
create type public.run_state as enum ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled');
create type public.step_state as enum ('queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped');
create type public.approval_state as enum ('pending', 'approved', 'rejected', 'expired');
create type public.connection_state as enum ('pending', 'connected', 'expired', 'disconnected');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  created_by uuid not null references auth.users(id),
  plan public.plan_id not null default 'free',
  subscription_status text not null default 'inactive',
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  credits_remaining integer not null default 1000 check (credits_remaining >= 0),
  credit_period_started_at timestamptz not null default date_trunc('month', now()),
  beta_access boolean not null default true,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.workspace_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null,
  role public.workspace_role not null default 'member' check (role <> 'owner'),
  token_hash text not null unique,
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default (now() + interval '7 days'),
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, email)
);

create table public.workspace_secrets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  ciphertext text not null,
  iv text not null,
  key_version smallint not null default 1,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  app_slug text not null,
  provider text not null default 'composio',
  provider_account_id text,
  status public.connection_state not null default 'pending',
  display_name text,
  metadata jsonb not null default '{}'::jsonb,
  connected_by uuid references auth.users(id),
  connected_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, app_slug, provider_account_id)
);

create table public.workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  description text not null default '',
  state public.workflow_state not null default 'draft',
  draft_version_id uuid,
  published_version_id uuid,
  webhook_token_hash text,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.workflow_versions (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  version integer not null check (version > 0),
  graph jsonb not null,
  change_summary text not null default '',
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique (workflow_id, version)
);

alter table public.workflows
  add constraint workflows_draft_version_fk foreign key (draft_version_id) references public.workflow_versions(id) on delete set null,
  add constraint workflows_published_version_fk foreign key (published_version_id) references public.workflow_versions(id) on delete set null;

create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  workflow_id uuid not null references public.workflows(id) on delete cascade,
  workflow_version_id uuid not null references public.workflow_versions(id),
  idempotency_key text not null,
  status public.run_state not null default 'queued',
  trigger_kind text not null,
  trigger_payload jsonb not null default '{}'::jsonb,
  context jsonb not null default '{}'::jsonb,
  current_step_id text,
  pending_approval_id uuid,
  credits_used integer not null default 0 check (credits_used >= 0),
  attempt_count smallint not null default 0,
  claimed_at timestamptz,
  heartbeat_at timestamptz,
  started_by uuid references auth.users(id),
  started_at timestamptz,
  finished_at timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  unique (workflow_id, idempotency_key)
);

create table public.workflow_run_steps (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  step_id text not null,
  step_type text not null,
  sequence integer not null,
  status public.step_state not null default 'queued',
  input jsonb,
  output jsonb,
  error_code text,
  error_message text,
  credits_used integer not null default 0 check (credits_used >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, sequence)
);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid not null references public.workflow_runs(id) on delete cascade,
  run_step_id uuid references public.workflow_run_steps(id) on delete cascade,
  status public.approval_state not null default 'pending',
  prompt text not null,
  preview jsonb not null default '{}'::jsonb,
  requested_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  decision_note text
);

alter table public.workflow_runs
  add constraint workflow_runs_pending_approval_fk foreign key (pending_approval_id) references public.approvals(id) on delete set null;

create table public.usage_ledger (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  run_id uuid references public.workflow_runs(id) on delete set null,
  run_step_id uuid references public.workflow_run_steps(id) on delete set null,
  idempotency_key text not null,
  credits integer not null,
  kind text not null check (kind in ('grant', 'debit', 'refund', 'adjustment')),
  description text not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, idempotency_key)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null,
  href text,
  email_status text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.notification_preferences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  in_app boolean not null default true,
  email boolean not null default true,
  events jsonb not null default '{"approval":true,"failure":true,"connection":true,"credits":true}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_hash text,
  created_at timestamptz not null default now()
);

create table public.beta_requests (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  company text,
  use_case text,
  status text not null default 'requested',
  created_at timestamptz not null default now()
);

create table public.billing_events (
  id text primary key,
  event_type text not null,
  workspace_id uuid references public.workspaces(id) on delete set null,
  processed_at timestamptz not null default now()
);

create index workflows_workspace_updated_idx on public.workflows (workspace_id, updated_at desc);
create index workflows_due_idx on public.workflows (next_run_at) where state = 'active';
create index workflow_versions_workflow_idx on public.workflow_versions (workflow_id, version desc);
create index workflow_runs_workspace_created_idx on public.workflow_runs (workspace_id, created_at desc);
create index workflow_runs_queue_idx on public.workflow_runs (created_at) where status in ('queued', 'running');
create index workflow_run_steps_run_idx on public.workflow_run_steps (run_id, sequence);
create index approvals_pending_idx on public.approvals (workspace_id, requested_at desc) where status = 'pending';
create index notifications_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;
create index usage_ledger_workspace_idx on public.usage_ledger (workspace_id, created_at desc);
create index audit_logs_workspace_idx on public.audit_logs (workspace_id, created_at desc);

create or replace function private.is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.workspace_members membership
    where membership.workspace_id = target_workspace
      and membership.user_id = (select auth.uid())
  );
$$;

create or replace function private.has_workspace_role(target_workspace uuid, allowed public.workspace_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.workspace_members membership
    where membership.workspace_id = target_workspace
      and membership.user_id = (select auth.uid())
      and membership.role = any(allowed)
  );
$$;

revoke all on function private.is_workspace_member(uuid) from public, anon;
revoke all on function private.has_workspace_role(uuid, public.workspace_role[]) from public, anon;
grant execute on function private.is_workspace_member(uuid) to authenticated;
grant execute on function private.has_workspace_role(uuid, public.workspace_role[]) to authenticated;

create or replace function private.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated before update on public.profiles for each row execute function private.touch_updated_at();
create trigger workspaces_touch_updated before update on public.workspaces for each row execute function private.touch_updated_at();
create trigger workspace_secrets_touch_updated before update on public.workspace_secrets for each row execute function private.touch_updated_at();
create trigger connections_touch_updated before update on public.connections for each row execute function private.touch_updated_at();
create trigger workflows_touch_updated before update on public.workflows for each row execute function private.touch_updated_at();
create trigger notification_preferences_touch_updated before update on public.notification_preferences for each row execute function private.touch_updated_at();

create or replace function private.protect_workspace_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_workspace uuid := coalesce(new.workspace_id, old.workspace_id);
  caller_is_owner boolean;
  owner_count integer;
begin
  -- Internal service operations have no end-user JWT. API handlers authorize
  -- those calls before using the service credential.
  if (select auth.uid()) is null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;

  select exists (
    select 1 from public.workspace_members
    where workspace_id = target_workspace
      and user_id = (select auth.uid())
      and role = 'owner'
  ) into caller_is_owner;

  if (tg_op = 'INSERT' and new.role = 'owner' and not caller_is_owner) or
     (tg_op = 'UPDATE' and (old.role = 'owner' or new.role = 'owner') and not caller_is_owner) or
     (tg_op = 'DELETE' and old.role = 'owner' and not caller_is_owner) then
    raise exception 'Only an owner can assign or remove the owner role';
  end if;

  if (tg_op = 'DELETE' and old.role = 'owner') or
     (tg_op = 'UPDATE' and old.role = 'owner' and new.role <> 'owner') then
    select count(*) from public.workspace_members
    where workspace_id = target_workspace and role = 'owner'
    into owner_count;
    if owner_count <= 1 then
      raise exception 'Workspace must retain at least one owner';
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function private.protect_workspace_roles() from public, anon, authenticated;
create trigger workspace_members_protect_roles
before insert or update or delete on public.workspace_members
for each row execute function private.protect_workspace_roles();

create or replace function private.protect_published_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.published_at is not null then
    raise exception 'Published workflow versions are immutable';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger workflow_versions_immutable
before update or delete on public.workflow_versions
for each row execute function private.protect_published_version();

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_workspace_id uuid := gen_random_uuid();
  workspace_name text := coalesce(nullif(new.raw_user_meta_data ->> 'full_name', ''), split_part(new.email, '@', 1), 'My workspace');
  workspace_slug text := lower(regexp_replace(split_part(coalesce(new.email, 'workspace'), '@', 1), '[^a-zA-Z0-9]+', '-', 'g')) || '-' || substr(new.id::text, 1, 6);
begin
  insert into public.profiles (id, full_name, avatar_url)
  values (new.id, new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'avatar_url');

  insert into public.workspaces (id, name, slug, created_by)
  values (new_workspace_id, workspace_name, workspace_slug, new.id);

  insert into public.workspace_members (workspace_id, user_id, role)
  values (new_workspace_id, new.id, 'owner');

  insert into public.notification_preferences (workspace_id, user_id)
  values (new_workspace_id, new.id);
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;
create trigger on_auth_user_created
after insert on auth.users
for each row execute function private.handle_new_user();

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.workspace_secrets enable row level security;
alter table public.connections enable row level security;
alter table public.workflows enable row level security;
alter table public.workflow_versions enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.workflow_run_steps enable row level security;
alter table public.approvals enable row level security;
alter table public.usage_ledger enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.audit_logs enable row level security;
alter table public.beta_requests enable row level security;
alter table public.billing_events enable row level security;

create policy "profiles_read_self" on public.profiles for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_update_self" on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "workspaces_read_member" on public.workspaces for select to authenticated using (private.is_workspace_member(id));
create policy "workspaces_create_self" on public.workspaces for insert to authenticated with check ((select auth.uid()) = created_by);
create policy "workspaces_update_admin" on public.workspaces for update to authenticated using (private.has_workspace_role(id, array['owner','admin']::public.workspace_role[])) with check (private.has_workspace_role(id, array['owner','admin']::public.workspace_role[]));
create policy "workspaces_delete_owner" on public.workspaces for delete to authenticated using (private.has_workspace_role(id, array['owner']::public.workspace_role[]));

create policy "members_read_workspace" on public.workspace_members for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "members_manage_admin" on public.workspace_members for all to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])) with check (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy "invitations_read_admin" on public.workspace_invitations for select to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));
create policy "invitations_manage_admin" on public.workspace_invitations for all to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])) with check (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy "connections_read_member" on public.connections for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "connections_manage_admin" on public.connections for all to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])) with check (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy "workflows_read_member" on public.workflows for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "workflows_create_editor" on public.workflows for insert to authenticated with check (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[]));
create policy "workflows_update_editor" on public.workflows for update to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[])) with check (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[]));
create policy "workflows_delete_admin" on public.workflows for delete to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy "versions_read_member" on public.workflow_versions for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "versions_create_editor" on public.workflow_versions for insert to authenticated with check (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[]));

create policy "runs_read_member" on public.workflow_runs for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "run_steps_read_member" on public.workflow_run_steps for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "usage_read_member" on public.usage_ledger for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "audit_read_member" on public.audit_logs for select to authenticated using (private.is_workspace_member(workspace_id));

create policy "approvals_read_member" on public.approvals for select to authenticated using (private.is_workspace_member(workspace_id));
create policy "approvals_decide_editor" on public.approvals for update to authenticated using (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[])) with check (private.has_workspace_role(workspace_id, array['owner','admin','member']::public.workspace_role[]));

create policy "notifications_read_self" on public.notifications for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications_update_self" on public.notifications for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "preferences_self" on public.notification_preferences for all to authenticated using ((select auth.uid()) = user_id and private.is_workspace_member(workspace_id)) with check ((select auth.uid()) = user_id and private.is_workspace_member(workspace_id));

revoke all on all tables in schema public from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_invitations to authenticated;
revoke all on public.workspace_secrets from anon, authenticated;
grant select, insert, update, delete on public.connections to authenticated;
grant select, insert, update, delete on public.workflows to authenticated;
grant select, insert on public.workflow_versions to authenticated;
grant select on public.workflow_runs to authenticated;
grant select on public.workflow_run_steps to authenticated;
grant select, update on public.approvals to authenticated;
grant select on public.usage_ledger to authenticated;
grant select, update on public.notifications to authenticated;
grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select on public.audit_logs to authenticated;
revoke all on public.beta_requests from anon, authenticated;
revoke all on public.billing_events from anon, authenticated;

grant usage, select on all sequences in schema public to authenticated;
