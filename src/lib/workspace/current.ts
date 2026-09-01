import "server-only";

import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function currentWorkspace() {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return null;
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return null;
  const { data: membership } = await supabase.from("workspace_members").select("workspace_id,role").eq("user_id", userId).order("joined_at").limit(1).single();
  if (!membership) return null;
  const { data: workspace } = await supabase.from("workspaces").select("id,name,plan,timezone,subscription_status").eq("id", membership.workspace_id).single();
  if (!workspace) return null;
  return { supabase, userId, role: membership.role, workspace };
}
