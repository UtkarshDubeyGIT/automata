import { NextResponse, type NextRequest } from "next/server";

import { PLANS, type PlanId } from "@/lib/billing/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { nextCronOccurrence } from "@/lib/workflows/schedule";
import type { WorkflowGraph } from "@/lib/workflows/types";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to publish a workflow." }, { status: 401 });
  const { id } = await params;
  const { data: workflow } = await supabase.from("workflows").select("id,workspace_id,draft_version_id,state").eq("id", id).single();
  if (!workflow?.draft_version_id) return NextResponse.json({ error: "Save a valid draft before publishing." }, { status: 409 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", workflow.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot publish workflows." }, { status: 403 });
  const { data: workspace } = await supabase.from("workspaces").select("plan,timezone").eq("id", workflow.workspace_id).single();
  const { count } = await supabase.from("workflows").select("id", { count: "exact", head: true }).eq("workspace_id", workflow.workspace_id).eq("state", "active").neq("id", id);
  const limit = PLANS[(workspace?.plan ?? "free") as PlanId].activeWorkflowLimit;
  if (workflow.state !== "active" && limit !== null && (count ?? 0) >= limit) return NextResponse.json({ error: `Your plan supports ${limit} active workflows.` }, { status: 402 });
  const publishedAt = new Date().toISOString();
  const { data: version } = await admin.from("workflow_versions").select("graph").eq("id", workflow.draft_version_id).single();
  const graph = version?.graph as WorkflowGraph | undefined;
  const schedule = graph ? Object.values(graph.steps).find((step) => step.type === "schedule_trigger") : undefined;
  let nextRunAt: string | null = null;
  if (schedule?.cron) {
    try { nextRunAt = nextCronOccurrence(String(schedule.cron), String(schedule.timezone ?? workspace?.timezone ?? "UTC")).toISOString(); } catch { return NextResponse.json({ error: "The schedule has an invalid cron expression or timezone." }, { status: 400 }); }
  }
  const { error: versionError } = await admin.from("workflow_versions").update({ published_at: publishedAt }).eq("id", workflow.draft_version_id).is("published_at", null);
  if (versionError) return NextResponse.json({ error: versionError.message }, { status: 500 });
  const { error } = await admin.from("workflows").update({ published_version_id: workflow.draft_version_id, state: "active", next_run_at: nextRunAt }).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ published: true, versionId: workflow.draft_version_id, publishedAt });
}
