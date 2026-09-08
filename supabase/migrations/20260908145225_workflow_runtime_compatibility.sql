-- Compatibility between Automata's workspace schema and the Zidane automation
-- runtime. This same bootstrap is included before the first dependent migration
-- so a fresh install does not fail before reaching this upgrade migration.
-- Existing workflows, versions, memberships and connections are preserved.

alter table public.workspaces
  add column if not exists owner_id uuid references auth.users(id),
  add column if not exists brand_profile jsonb not null default '{}'::jsonb,
  add column if not exists onboarded boolean not null default true;
update public.workspaces set owner_id = created_by where owner_id is null;

create or replace function public.owns_workspace(target_workspace uuid)
returns boolean language sql stable security invoker set search_path = '' as $$
  select private.has_workspace_role(target_workspace, array['owner','admin','member']::public.workspace_role[]);
$$;
revoke all on function public.owns_workspace(uuid) from public, anon;
grant execute on function public.owns_workspace(uuid) to authenticated, service_role;

create table if not exists public.credit_ledger (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  delta integer not null, reason text not null, ref text, idem_key text,
  created_at timestamptz not null default now()
);
alter table public.credit_ledger add column if not exists idem_key text;
create unique index if not exists credit_ledger_workspace_idem_key_idx
  on public.credit_ledger(workspace_id, idem_key) where idem_key is not null;
create index if not exists credit_ledger_workspace_idx on public.credit_ledger(workspace_id);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  platform text not null, status text not null default 'disconnected',
  connected_account_id text, meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), unique(workspace_id, platform)
);
create table if not exists public.agent_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  autonomy text not null default 'review', server_auto boolean not null default false,
  cadence text not null default 'Every 15 min', daily_cap integer not null default 200,
  pause_below integer not null default 50, timezone text not null default 'UTC',
  guardrails jsonb not null default '{"posts":true,"voice":true,"sensitive":true,"cap":true,"approval":false}'::jsonb
);
create table if not exists public.billing_customers (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  stripe_customer_id text, stripe_subscription_id text, plan text not null default 'free',
  status text not null default 'inactive', current_period_end timestamptz
);
create table if not exists public.content_items (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  format text not null, tone text, topic text, body text not null, viral_score integer,
  status text not null default 'draft', platform text, asset_url text,
  meta jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  kind text not null, prompt text not null, status text not null default 'queued',
  job_id text, url text, thumbnail_url text, aspect_ratio text, duration_sec numeric,
  voiced_url text, voiceover_script text, voiceover_claimed_at timestamptz,
  voiceover_status text, voiced_duration_sec numeric, target_duration_sec numeric,
  provider_request_id text, provider_prompt text, segments jsonb, assembly_status text,
  assembly_claimed_at timestamptz, tone text, target_takes integer, plan jsonb,
  plan_status text, plan_claimed_at timestamptz, keyframe_status text,
  keyframe_claimed_at timestamptz, pipeline text, metrics jsonb, brand_snapshot jsonb,
  created_at timestamptz not null default now()
);

alter table public.workflows
  add column if not exists active boolean not null default false,
  add column if not exists schedule text,
  add column if not exists config jsonb not null default '{}'::jsonb,
  add column if not exists draft_config jsonb,
  add column if not exists runs integer not null default 0,
  add column if not exists success_rate text;
update public.workflows set config='{}'::jsonb where config is null;
alter table public.workflows alter column config set default '{}'::jsonb, alter column config set not null;
alter type public.run_state add value if not exists 'completed';
alter table public.workflow_runs
  add column if not exists graph jsonb,
  add column if not exists log jsonb not null default '{"v":1,"journal":[],"context":{"steps":{},"input":{}}}'::jsonb,
  alter column workflow_version_id drop not null,
  alter column trigger_kind set default 'manual',
  alter column idempotency_key set default gen_random_uuid()::text,
  alter column started_at set default now();

-- The runtime stores a frozen graph per run instead of requiring a published
-- version row. Tenant ids and creator ids still come from the parent workspace.
create or replace function private.populate_runtime_identity()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_table_name = 'workflows' then
    if new.created_by is null then
      select coalesce(auth.uid(), w.owner_id, w.created_by) into new.created_by
        from public.workspaces w where w.id = new.workspace_id;
    end if;
  else
    select w.workspace_id into new.workspace_id from public.workflows w where w.id = new.workflow_id;
  end if;
  return new;
end;
$$;
revoke all on function private.populate_runtime_identity() from public, anon, authenticated;
drop trigger if exists workflows_runtime_identity on public.workflows;
create trigger workflows_runtime_identity before insert on public.workflows
  for each row execute function private.populate_runtime_identity();
drop trigger if exists runs_runtime_identity on public.workflow_runs;
create trigger runs_runtime_identity before insert or update of workflow_id, workspace_id on public.workflow_runs
  for each row execute function private.populate_runtime_identity();

-- The workspace update and timezone used by unattended schedules commit together.
create or replace function private.sync_runtime_workspace()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    insert into public.credit_ledger(workspace_id,delta,reason,idem_key)
      values(new.id,1000,'signup_bonus','automata:opening-balance') on conflict do nothing;
  end if;
  insert into public.agent_settings(workspace_id,timezone) values(new.id,new.timezone)
    on conflict(workspace_id) do update set timezone = excluded.timezone;
  insert into public.billing_customers(workspace_id,plan,status,stripe_customer_id,stripe_subscription_id)
    values(new.id,new.plan::text,new.subscription_status,new.stripe_customer_id,new.stripe_subscription_id)
    on conflict(workspace_id) do update set plan=excluded.plan,status=excluded.status,
      stripe_customer_id=excluded.stripe_customer_id,stripe_subscription_id=excluded.stripe_subscription_id;
  return new;
end;
$$;
revoke all on function private.sync_runtime_workspace() from public, anon, authenticated;
drop trigger if exists workspaces_runtime_sync on public.workspaces;
create trigger workspaces_runtime_sync after insert or update of timezone, plan, subscription_status, stripe_customer_id, stripe_subscription_id
  on public.workspaces for each row execute function private.sync_runtime_workspace();
create or replace function private.populate_workspace_owner()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.owner_id is null then new.owner_id := new.created_by; end if;
  return new;
end;
$$;
revoke all on function private.populate_workspace_owner() from public, anon, authenticated;
drop trigger if exists workspaces_runtime_owner on public.workspaces;
create trigger workspaces_runtime_owner before insert on public.workspaces
  for each row execute function private.populate_workspace_owner();

insert into public.credit_ledger(workspace_id,delta,reason,idem_key)
select id, credits_remaining, 'signup_bonus', 'automata:opening-balance' from public.workspaces w
where not exists (select 1 from public.credit_ledger l where l.workspace_id = w.id)
on conflict do nothing;
insert into public.agent_settings(workspace_id,timezone)
select id,timezone from public.workspaces on conflict(workspace_id) do nothing;
insert into public.billing_customers(workspace_id,plan,status,stripe_customer_id,stripe_subscription_id)
select id,plan::text,subscription_status,stripe_customer_id,stripe_subscription_id from public.workspaces
on conflict(workspace_id) do nothing;
insert into public.integrations(workspace_id,platform,status,connected_account_id,meta)
select distinct on (workspace_id,app_slug) workspace_id,app_slug,status::text,provider_account_id,metadata
from public.connections order by workspace_id,app_slug,updated_at desc
on conflict(workspace_id,platform) do nothing;

-- Browser grants and row policies are explicit; balances and provider data are
-- worker-written. No anonymous role can query the compatibility tables.
do $$
declare runtime_table text;
begin
  foreach runtime_table in array array['credit_ledger','integrations','agent_settings','billing_customers','content_items','videos'] loop
    execute format('alter table public.%I enable row level security', runtime_table);
    execute format('revoke all on public.%I from anon, authenticated', runtime_table);
    execute format('grant select on public.%I to authenticated', runtime_table);
    execute format('grant all on public.%I to service_role', runtime_table);
    execute format('drop policy if exists runtime_member_read on public.%I', runtime_table);
    execute format('create policy runtime_member_read on public.%I for select to authenticated using (private.is_workspace_member(workspace_id))', runtime_table);
  end loop;
end;
$$;
grant usage, select on sequence public.credit_ledger_id_seq to service_role;
grant all on public.workflow_runs, public.workflows, public.job_locks to service_role;

-- Generated media must remain available after provider URLs expire. Public read
-- matches the URLs emitted by image and video steps; uploads remain server-only.
insert into storage.buckets(id,name,public)
values ('content-images','content-images',true),('videos','videos',true),('product-assets','product-assets',true)
on conflict(id) do nothing;
grant usage on schema private to service_role;
grant all on public.workspaces to service_role;

-- User-editable workspace settings never include billing identifiers, plan or
-- balances. The signed Stripe webhook writes those with the service role.
revoke insert, update on public.workspaces from authenticated;
grant insert(name,slug,created_by,timezone,brand_profile) on public.workspaces to authenticated;
grant update(name,slug,timezone,brand_profile,onboarded) on public.workspaces to authenticated;

-- Bring forward compatible graphs from the original version-based editor.
-- Unknown historical formats remain in draft_graph/workflow_versions verbatim;
-- they are never activated by guessing how their nodes should execute.
with saved as (
  select w.id,
    coalesce(w.draft_graph,draft.graph,published.graph) as draft_payload,
    coalesce(published.graph,w.draft_graph,draft.graph) as runtime_payload
  from public.workflows w
  left join public.workflow_versions draft on draft.id=w.draft_version_id
  left join public.workflow_versions published on published.id=w.published_version_id
), normalized as (
  select id,
    case when jsonb_typeof(draft_payload->'graph'->'steps')='object' and jsonb_typeof(draft_payload->'graph'->'start')='string'
      then draft_payload || '{"v":1}'::jsonb
      when jsonb_typeof(draft_payload->'steps')='object' and jsonb_typeof(draft_payload->'start')='string'
      then jsonb_build_object('v',1,'graph',draft_payload) end as draft_config,
    case when jsonb_typeof(runtime_payload->'graph'->'steps')='object' and jsonb_typeof(runtime_payload->'graph'->'start')='string'
      then runtime_payload || '{"v":1}'::jsonb
      when jsonb_typeof(runtime_payload->'steps')='object' and jsonb_typeof(runtime_payload->'start')='string'
      then jsonb_build_object('v',1,'graph',runtime_payload) end as config
  from saved
)
update public.workflows w set
  draft_config=case when w.draft_config->'graph' is null and normalized.draft_config is not null then normalized.draft_config else w.draft_config end,
  config=case when w.config->'graph' is null and normalized.config is not null then normalized.config else w.config end,
  active=case when w.config->'graph' is null and normalized.config is not null then w.state='active' else w.active end
from normalized where normalized.id=w.id
  and (normalized.config is not null or normalized.draft_config is not null);
