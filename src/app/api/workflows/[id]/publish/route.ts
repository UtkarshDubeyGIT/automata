import { NextResponse, type NextRequest } from "next/server";

import { PLANS, type PlanId } from "@/lib/billing/plans";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { nextCronOccurrence } from "@/lib/workflows/schedule";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { applySafetyDefaults } from "@/lib/workflows/safety";
import { validateGraph } from "@/lib/workflows/validate";
import { draftIssues } from "@/lib/workflows/editor";

type Params = { params: Promise<{ id: string }> };

export async function POST(_request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to publish a workflow." }, { status: 401 });
  const { id } = await params;
  const { data: workflow } = await supabase.from("workflows").select("id,workspace_id,draft_graph,draft_revision,state").eq("id", id).single();
  if (!workflow?.draft_graph) return NextResponse.json({ error: "Save a valid draft before publishing." }, { status: 409 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", workflow.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot publish workflows." }, { status: 403 });
  const { data: workspace } = await supabase.from("workspaces").select("plan,timezone").eq("id", workflow.workspace_id).single();
  const { count } = await supabase.from("workflows").select("id", { count: "exact", head: true }).eq("workspace_id", workflow.workspace_id).eq("state", "active").neq("id", id);
  const limit = PLANS[(workspace?.plan ?? "free") as PlanId].activeWorkflowLimit;
  if (workflow.state !== "active" && limit !== null && (count ?? 0) >= limit) return NextResponse.json({ error: `Your plan supports ${limit} active workflows.` }, { status: 402 });
  const publishedAt = new Date().toISOString();
  const graph = applySafetyDefaults(workflow.draft_graph as WorkflowGraph, { allowUnattendedWrites: false });
  const errors = [...validateGraph(graph), ...draftIssues(graph).map((issue) => issue.message)];
  if (errors.length) return NextResponse.json({ error: "Finish setting up the draft before publishing.", details: [...new Set(errors)] }, { status: 409 });
  const schedule = graph ? Object.values(graph.steps).find((step) => step.type === "schedule_trigger") : undefined;
  let nextRunAt: string | null = null;
  if (schedule?.cron) {
    try { nextRunAt = nextCronOccurrence(String(schedule.cron), String(schedule.timezone ?? workspace?.timezone ?? "UTC")).toISOString(); } catch { return NextResponse.json({ error: "The schedule has an invalid cron expression or timezone." }, { status: 400 }); }
  }
  const { data: versionId, error } = await supabase.rpc("publish_workflow_draft", {
    p_workflow_id: id,
    p_base_revision: workflow.draft_revision,
    p_graph: graph,
    p_next_run_at: nextRunAt,
  });
  if (error?.message.includes("revision_conflict") || error?.code === "40001") {
    return NextResponse.json({ error: "revision_conflict", code: "revision_conflict" }, { status: 409 });
  }
  if (error || !versionId) return NextResponse.json({ error: error?.message ?? "The published version could not be created." }, { status: 500 });
  return NextResponse.json({ published: true, versionId, publishedAt });
}
