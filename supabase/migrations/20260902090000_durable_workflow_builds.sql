-- Durable AI workflow builds. The browser pays and enqueues in one transaction,
-- then reads status while service-role workers exclusively mutate the job.

create table if not exists public.workflow_builds (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  request_key        text not null,
  prompt             text not null,
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'completed', 'failed')),
  result             jsonb,
  error              text,
  error_code         text,
  attempts           integer not null default 0,
  claimed_at         timestamptz,
  claimed_by         text,
  charged_at         timestamptz,
  refunded_at        timestamptz,
  finished_at        timestamptz,
  available_at       timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '24 hours'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (workspace_id, request_key),
  check (char_length(request_key) between 1 and 100),
  check (char_length(prompt) between 1 and 1000)
);

create index if not exists workflow_builds_queue_idx
  on public.workflow_builds (available_at, created_at)
  where status = 'queued';

create index if not exists workflow_builds_refund_idx
  on public.workflow_builds (created_at)
  where status = 'failed' and charged_at is not null and refunded_at is null;

alter table public.workflow_builds enable row level security;

drop policy if exists "workflow builds read" on public.workflow_builds;
create policy "workflow builds read" on public.workflow_builds
  for select using (public.owns_workspace(workspace_id));

-- Ledger entries are an audit trail and must never be writable by a browser.
-- Server-side credit helpers use service role and continue to bypass RLS.
drop policy if exists "ws access" on public.credit_ledger;
drop policy if exists "credit ledger read" on public.credit_ledger;
create policy "credit ledger read" on public.credit_ledger
  for select using (public.owns_workspace(workspace_id));

-- Every debit, including legacy spendCredits callers, participates in the
-- same workspace lock as enqueue. Without this trigger, a direct ledger debit
-- could land between enqueue's balance check and insert and leave the account
-- negative with neither transaction seeing the other's uncommitted row.
create or replace function public.serialize_credit_debit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.delta < 0 then
    perform 1 from public.workspaces where id = new.workspace_id for update;
  end if;
  return new;
end;
$$;

drop trigger if exists credit_ledger_serialize_debit on public.credit_ledger;
create trigger credit_ledger_serialize_debit
  before insert on public.credit_ledger
  for each row execute function public.serialize_credit_debit();

revoke all on function public.serialize_credit_debit() from public, anon, authenticated;

create or replace function public.enqueue_workflow_build(
  p_workspace_id uuid,
  p_request_key text,
  p_prompt text,
  p_cost integer
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.workflow_builds%rowtype;
  v_balance integer;
begin
  if auth.uid() is null or not public.owns_workspace(p_workspace_id) then
    raise exception 'unauthorized' using errcode = '42501';
  end if;
  if char_length(p_request_key) not between 1 and 100
     or char_length(btrim(p_prompt)) not between 1 and 1000
     -- The RPC is callable by authenticated clients, so its price cannot be
     -- caller-selected. Keep this in sync with CREDIT_COST.workflow_build.
     or p_cost <> 3 then
    raise exception 'invalid workflow build request' using errcode = '22023';
  end if;

  select * into v_job
    from public.workflow_builds
   where workspace_id = p_workspace_id and request_key = p_request_key;
  if found then
    select coalesce(sum(delta), 0)::integer into v_balance
      from public.credit_ledger where workspace_id = p_workspace_id;
    return jsonb_build_object(
      'outcome', 'queued', 'job', to_jsonb(v_job), 'duplicate', true,
      'balance', v_balance, 'cost', p_cost
    );
  end if;

  -- Serialize balance decisions for this workspace. Existing spendCredits
  -- joins this lock through credit_ledger_serialize_debit.
  perform 1 from public.workspaces where id = p_workspace_id for update;

  -- A concurrent request with this key may have committed while this request
  -- waited for the workspace lock. Idempotency wins before affordability.
  select * into v_job
    from public.workflow_builds
   where workspace_id = p_workspace_id and request_key = p_request_key;
  if found then
    select coalesce(sum(delta), 0)::integer into v_balance
      from public.credit_ledger where workspace_id = p_workspace_id;
    return jsonb_build_object(
      'outcome', 'queued', 'job', to_jsonb(v_job), 'duplicate', true,
      'balance', v_balance, 'cost', p_cost
    );
  end if;

  select coalesce(sum(delta), 0)::integer into v_balance
    from public.credit_ledger where workspace_id = p_workspace_id;
  if v_balance < p_cost then
    return jsonb_build_object(
      'outcome', 'insufficient', 'job', null, 'duplicate', false,
      'balance', v_balance, 'cost', p_cost
    );
  end if;

  insert into public.workflow_builds (workspace_id, request_key, prompt, charged_at)
  values (p_workspace_id, p_request_key, btrim(p_prompt), now())
  returning * into v_job;

  insert into public.credit_ledger (workspace_id, delta, reason, ref, idem_key)
  values (
    p_workspace_id, -p_cost, 'workflow_build',
    'workflow_build:' || v_job.id::text,
    'workflow-build:' || v_job.id::text
  );

  return jsonb_build_object(
    'outcome', 'queued', 'job', to_jsonb(v_job), 'duplicate', false,
    'balance', v_balance - p_cost, 'cost', p_cost
  );
exception
  when unique_violation then
    select * into v_job
      from public.workflow_builds
     where workspace_id = p_workspace_id and request_key = p_request_key;
    select coalesce(sum(delta), 0)::integer into v_balance
      from public.credit_ledger where workspace_id = p_workspace_id;
    return jsonb_build_object(
      'outcome', 'queued', 'job', to_jsonb(v_job), 'duplicate', true,
      'balance', v_balance, 'cost', p_cost
    );
end;
$$;

revoke all on function public.enqueue_workflow_build(uuid, text, text, integer) from public, anon;
grant execute on function public.enqueue_workflow_build(uuid, text, text, integer) to authenticated;
