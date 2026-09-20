-- Team is no longer a product plan. Preserve existing subscribers by moving
-- their stored entitlement to Pro before removing the enum value.
update public.billing_customers set plan = 'pro' where plan = 'team';

alter table public.workspaces alter column plan drop default;
alter type public.plan_id rename to plan_id_with_retired_team;
create type public.plan_id as enum ('free', 'pro');

alter table public.workspaces
  alter column plan type public.plan_id
  using (
    case when plan::text = 'team' then 'pro' else plan::text end
  )::public.plan_id;

alter table public.workspaces alter column plan set default 'free'::public.plan_id;
drop type public.plan_id_with_retired_team;
