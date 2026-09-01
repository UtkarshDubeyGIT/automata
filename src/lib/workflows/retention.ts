import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PLANS, type PlanId } from "@/lib/billing/plans";

export async function cleanupExpiredRuns(admin: SupabaseClient) {
  const { data: workspaces, error } = await admin.from("workspaces").select("id,plan");
  if (error) throw new Error(`Retention scan failed: ${error.message}`);
  let removed = 0;
  for (const workspace of workspaces ?? []) {
    const days = PLANS[(workspace.plan ?? "free") as PlanId].retentionDays;
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const { data, error: deleteError } = await admin.from("workflow_runs").delete().eq("workspace_id", workspace.id).in("status", ["succeeded", "failed", "cancelled"]).lt("finished_at", cutoff).select("id");
    if (deleteError) throw new Error(`Retention cleanup failed: ${deleteError.message}`);
    removed += data?.length ?? 0;
  }
  return removed;
}
