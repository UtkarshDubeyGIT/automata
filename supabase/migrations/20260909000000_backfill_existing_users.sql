-- The on_auth_user_created trigger was introduced by 20260831152749_automata_mvp
-- against a project that already had signed-up users. Those users have no
-- profile, workspace, membership or notification preferences, so the app has
-- nothing to load for them. This mirrors private.handle_new_user() exactly,
-- including the workspace name and slug derivation, and is safe to re-run.

insert into public.profiles (id, full_name, avatar_url)
select u.id,
       u.raw_user_meta_data ->> 'full_name',
       u.raw_user_meta_data ->> 'avatar_url'
from auth.users u
on conflict (id) do nothing;

do $$
declare
  u record;
  new_workspace_id uuid;
  workspace_name text;
  workspace_slug text;
begin
  for u in
    select id, email, raw_user_meta_data
      from auth.users existing
     where not exists (
       select 1 from public.workspace_members m where m.user_id = existing.id
     )
     order by id
  loop
    new_workspace_id := gen_random_uuid();
    workspace_name := coalesce(
      nullif(u.raw_user_meta_data ->> 'full_name', ''),
      split_part(u.email, '@', 1),
      'My workspace'
    );
    workspace_slug := lower(regexp_replace(
      split_part(coalesce(u.email, 'workspace'), '@', 1), '[^a-zA-Z0-9]+', '-', 'g'
    )) || '-' || substr(u.id::text, 1, 6);

    insert into public.workspaces (id, name, slug, created_by)
    values (new_workspace_id, workspace_name, workspace_slug, u.id)
    on conflict (slug) do nothing;

    -- A prior partial run may have created the workspace without the
    -- membership. Adopt whichever workspace now carries this slug.
    select w.id into new_workspace_id
      from public.workspaces w
     where w.slug = workspace_slug;

    insert into public.workspace_members (workspace_id, user_id, role)
    values (new_workspace_id, u.id, 'owner')
    on conflict (workspace_id, user_id) do nothing;

    insert into public.notification_preferences (workspace_id, user_id)
    values (new_workspace_id, u.id)
    on conflict (workspace_id, user_id) do nothing;
  end loop;
end;
$$;
