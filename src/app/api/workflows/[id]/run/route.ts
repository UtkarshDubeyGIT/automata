import { randomUUID } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { PLANS } from "@/lib/billing/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { executeStoredRun } from "@/lib/workflows/run-service";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { validateGraph } from "@/lib/workflows/validate";
import { draftIssues } from "@/lib/workflows/editor";

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 60;

export async function POST(request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to run a workflow." }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { triggerData?: unknown; idempotencyKey?: string };
  const idempotencyKey = body.idempotencyKey?.slice(0, 200) || `manual:${randomUUID()}`;
  const { data: workflow, error: workflowError } = await supabase.from("workflows").select("id, workspace_id, draft_graph, draft_revision, published_version_id").eq("id", id).single();
  if (workflowError || !workflow) return NextResponse.json({ error: "Workflow not found in this workspace." }, { status: 404 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", workflow.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot run workflows." }, { status: 403 });
  const graph = workflow.draft_graph as WorkflowGraph | null;
  if (!graph) return NextResponse.json({ error: "Save this draft before running it." }, { status: 409 });
  const graphErrors = [...validateGraph(graph), ...draftIssues(graph).map((issue) => issue.message)];
  if (graphErrors.length) return NextResponse.json({ error: "Finish setting up the draft before running it.", details: [...new Set(graphErrors)] }, { status: 409 });
  const { data: latest } = await admin.from("workflow_versions").select("version").eq("workflow_id", id).order("version", { ascending: false }).limit(1).maybeSingle();
  const { data: version, error: versionError } = await admin.from("workflow_versions").insert({ workflow_id: id, workspace_id: workflow.workspace_id, version: Number(latest?.version ?? 0) + 1, graph, change_summary: `Draft test r${workflow.draft_revision}`, created_by: userId }).select("id,graph").single();
  if (versionError || !version) return NextResponse.json({ error: versionError?.message ?? "The draft test version could not be created." }, { status: 500 });

  const monthStart = new Date();
  monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: workspace } = await admin.from("workspaces").select("plan").eq("id", workflow.workspace_id).single();
  const { data: debits } = await admin.from("usage_ledger").select("credits").eq("workspace_id", workflow.workspace_id).eq("kind", "debit").gte("created_at", monthStart.toISOString());
  const plan = PLANS[(workspace?.plan ?? "free") as keyof typeof PLANS] ?? PLANS.free;
  const used = (debits ?? []).reduce((sum, row) => sum + Number(row.credits), 0);
  if (used >= plan.monthlyCredits) return NextResponse.json({ error: "This workspace has used its monthly credits." }, { status: 402 });

  const { data: created, error: createError } = await admin.from("workflow_runs").insert({
    workspace_id: workflow.workspace_id,
    workflow_id: workflow.id,
    workflow_version_id: version.id,
    idempotency_key: idempotencyKey,
    trigger_kind: "manual",
    trigger_payload: body.triggerData ?? {},
    started_by: userId,
  }).select("id").single();

  if (createError?.code === "23505") {
    const { data: existing } = await supabase.from("workflow_runs").select("id,status,credits_used,error_message,pending_approval_id").eq("workflow_id", workflow.id).eq("idempotency_key", idempotencyKey).single();
    return NextResponse.json({ run: existing, replayed: true }, { status: 200 });
  }
  if (createError || !created) return NextResponse.json({ error: createError?.message ?? "Run could not be created." }, { status: 500 });

  try {
    const result = await executeStoredRun(admin, {
      id: created.id,
      workspaceId: workflow.workspace_id,
      graph: version.graph as WorkflowGraph,
      triggerData: body.triggerData ?? {},
    });
    return NextResponse.json({ run: result }, { status: result.state === "failed" ? 502 : 200 });
  } catch (error) {
    await admin.from("workflow_runs").update({ status: "failed", error_code: "runner_error", error_message: error instanceof Error ? error.message : "Runner failed", finished_at: new Date().toISOString() }).eq("id", created.id);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Runner failed", runId: created.id }, { status: 500 });
  }
}
