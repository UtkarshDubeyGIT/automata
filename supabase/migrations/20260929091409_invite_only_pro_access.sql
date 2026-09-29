-- A request is also the durable history of a complimentary Pro grant.
create table public.pro_access_requests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  requested_by uuid not null references auth.users(id),
  requester_email text not null,
  workspace_name text not null,
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  email_status text not null default 'pending' check (email_status in ('pending', 'sent', 'failed')),
  notification_status text not null default 'pending' check (notification_status in ('pending', 'sent', 'failed')),
  notification_attempts integer not null default 0,
  notification_next_at timestamptz not null default now(),
  requested_at timestamptz not null default now(),
  link_expires_at timestamptz not null default (now() + interval '7 days'),
  decided_at timestamptz,
  access_expires_at timestamptz,
  expired_at timestamptz,
  check ((status = 'approved') = (access_expires_at is not null))
);
create unique index pro_access_one_pending_per_workspace
  on public.pro_access_requests(workspace_id) where status = 'pending';
create index pro_access_workspace_history
  on public.pro_access_requests(workspace_id, decided_at desc);
create index pro_access_notifications
  on public.pro_access_requests(notification_status, decided_at)
  where status <> 'pending' and notification_status <> 'sent';
create index pro_access_expiry on public.pro_access_requests(access_expires_at)
  where status = 'approved' and expired_at is null;

-- Older installations may have the Automata tables without the private
-- authorization helpers used by their RLS policies. Keep this migration
-- self-contained so the policy below can be installed on those databases too.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create or replace function private.is_workspace_member(target_workspace uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_member boolean;
begin
  if v_user is null then
    return false;
  end if;

  -- The membership table exists in the current schema, but older compatible
  -- deployments only have an owner on workspaces. Dynamic SQL avoids resolving
  -- the absent table while installing this function on those deployments.
  if pg_catalog.to_regclass('public.workspace_members') is not null then
    execute 'select exists (
      select 1 from public.workspace_members membership
      where membership.workspace_id = $1 and membership.user_id = $2
    )' into v_member using target_workspace, v_user;
    return coalesce(v_member, false);
  end if;

  return exists (
    select 1 from public.workspaces workspace
    where workspace.id = target_workspace
      and (
        pg_catalog.to_jsonb(workspace)->>'owner_id' = v_user::text
        or pg_catalog.to_jsonb(workspace)->>'created_by' = v_user::text
      )
  );
end;
$$;
revoke all on function private.is_workspace_member(uuid) from public, anon, authenticated;
grant execute on function private.is_workspace_member(uuid) to authenticated;

alter table public.pro_access_requests enable row level security;
revoke all on public.pro_access_requests from public, anon, authenticated;
grant select (id,workspace_id,requested_by,requester_email,workspace_name,status,email_status,notification_status,notification_attempts,notification_next_at,
  requested_at,link_expires_at,decided_at,access_expires_at,expired_at)
  on public.pro_access_requests to authenticated;
grant all on public.pro_access_requests to service_role;
create policy pro_access_workspace_read on public.pro_access_requests
  for select to authenticated using (private.is_workspace_member(workspace_id));

-- Called only by the service role after the route hashes a submitted bearer token.
-- Row and workspace locks serialize concurrent decisions and the credit grant.
create function public.decide_pro_access(p_token_hash text, p_decision text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_request public.pro_access_requests%rowtype;
  v_workspace public.workspaces%rowtype;
  v_now timestamptz := now();
  v_expires timestamptz;
begin
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'invalid decision' using errcode = '22023';
  end if;
  select * into v_request from public.pro_access_requests
    where token_hash = p_token_hash for update;
  if not found or v_request.status <> 'pending' or v_request.link_expires_at <= v_now then
    return jsonb_build_object('outcome', 'invalid');
  end if;

  if p_decision = 'approved' then
    select * into v_workspace from public.workspaces where id = v_request.workspace_id for update;
    if not found then return jsonb_build_object('outcome', 'invalid'); end if;
    if v_workspace.plan = 'pro' or
       (v_workspace.stripe_subscription_id is not null and v_workspace.subscription_status in ('active', 'trialing', 'past_due')) then
      update public.pro_access_requests set status = 'declined', decided_at = v_now,
        notification_status = 'sent' where id = v_request.id;
      return jsonb_build_object('outcome', 'already_pro');
    end if;
    v_expires := v_now + interval '30 days';
    update public.workspaces set plan = 'pro', subscription_status = 'invite_active'
      where id = v_request.workspace_id;
    insert into public.credit_ledger(workspace_id, delta, reason, ref, idem_key)
      values(v_request.workspace_id, 10000, 'plan_grant', v_request.id::text, 'pro-access:' || v_request.id::text);
    update public.pro_access_requests set status = 'approved', decided_at = v_now,
      access_expires_at = v_expires where id = v_request.id;
  else
    update public.pro_access_requests set status = 'declined', decided_at = v_now
      where id = v_request.id;
  end if;
  return jsonb_build_object('outcome', p_decision, 'request_id', v_request.id);
end;
$$;
revoke all on function public.decide_pro_access(text, text) from public, anon, authenticated;
grant execute on function public.decide_pro_access(text, text) to service_role;

-- The existing authenticated cron/worker calls this through the service role.
create function public.expire_pro_access()
returns integer language plpgsql security invoker set search_path = '' as $$
declare
  v_request public.pro_access_requests%rowtype;
  v_count integer := 0;
begin
  for v_request in
    select * from public.pro_access_requests
    where status = 'approved' and access_expires_at <= now() and expired_at is null
    order by access_expires_at for update skip locked
  loop
    update public.workspaces set plan = 'free', subscription_status = 'inactive'
      where id = v_request.workspace_id and subscription_status = 'invite_active';
    if found then v_count := v_count + 1; end if;
    update public.pro_access_requests set expired_at = now() where id = v_request.id;
  end loop;
  return v_count;
end;
$$;
revoke all on function public.expire_pro_access() from public, anon, authenticated;
grant execute on function public.expire_pro_access() to service_role;
