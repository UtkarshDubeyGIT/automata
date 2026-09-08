-- 20260901170006_atomic_workflow_publication revoked publish_workflow_draft
-- `from public` only. PUBLIC is the SQL pseudo-role; it is not Supabase's
-- `anon` role, which holds a separate EXECUTE grant from the default
-- privileges applied to new functions in the public schema. So the revoke
-- missed it and the RPC stayed callable without signing in.
--
-- Nothing was exposed: the function checks private.has_workspace_role(), which
-- opens with `auth.uid() is not null`, so an anonymous caller was always
-- rejected. But the function is SECURITY DEFINER and therefore bypasses RLS —
-- that single guard is all that stands between the internet and an
-- unauthenticated write to any workspace's published graph. Removing the grant
-- means a future edit to the guard cannot silently become a hole.
--
-- 20260902090000_durable_workflow_builds already uses the correct
-- `from public, anon` form for enqueue_workflow_build; this brings the older
-- function in line.

revoke all on function public.publish_workflow_draft(uuid, bigint, jsonb, timestamptz)
  from public, anon;

grant execute on function public.publish_workflow_draft(uuid, bigint, jsonb, timestamptz)
  to authenticated;
