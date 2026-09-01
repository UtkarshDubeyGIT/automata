import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { executeStoredRun } from "@/lib/workflows/run-service";
import type { WorkflowGraph } from "@/lib/workflows/types";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to decide an approval." }, { status: 401 });

  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { decision?: string; note?: string };
  if (body.decision !== "approved" && body.decision !== "rejected") return NextResponse.json({ error: "Decision must be approved or rejected." }, { status: 400 });

  const { data: approval, error: approvalError } = await supabase.from("approvals").select("id,status,run_id,workspace_id").eq("id", id).single();
  if (approvalError || !approval) return NextResponse.json({ error: "Approval not found in this workspace." }, { status: 404 });
  if (approval.status !== "pending") return NextResponse.json({ error: "This approval has already been decided." }, { status: 409 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", approval.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot decide approvals." }, { status: 403 });

  const decidedAt = new Date().toISOString();
  const { data: decided, error: decideError } = await supabase.from("approvals").update({
    status: body.decision,
    decided_by: userId,
    decided_at: decidedAt,
    decision_note: body.note?.slice(0, 1_000) ?? null,
  }).eq("id", id).eq("status", "pending").select("id").maybeSingle();
  if (decideError) return NextResponse.json({ error: decideError.message }, { status: 500 });
  if (!decided) return NextResponse.json({ error: "This approval was decided by someone else." }, { status: 409 });

  const { data: run, error: runError } = await admin.from("workflow_runs").select("id,workspace_id,workflow_version_id,trigger_payload,context,current_step_id,credits_used").eq("id", approval.run_id).single();
  if (runError || !run) return NextResponse.json({ error: "The paused run no longer exists." }, { status: 410 });
  const { data: version, error: versionError } = await admin.from("workflow_versions").select("graph").eq("id", run.workflow_version_id).single();
  if (versionError || !version || !run.current_step_id) return NextResponse.json({ error: "The paused workflow version is unavailable." }, { status: 410 });

  try {
    const result = await executeStoredRun(admin, {
      id: run.id,
      workspaceId: run.workspace_id,
      graph: version.graph as WorkflowGraph,
      triggerData: run.trigger_payload,
      existingOutputs: (run.context as { outputs?: Record<string, unknown> } | null)?.outputs ?? {},
      baseCredits: run.credits_used,
      resume: { approvalStepId: run.current_step_id, decision: body.decision },
    });
    return NextResponse.json({ run: result });
  } catch (error) {
    await admin.from("workflow_runs").update({ status: "failed", error_code: "runner_error", error_message: error instanceof Error ? error.message : "Runner failed", finished_at: new Date().toISOString() }).eq("id", run.id);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Runner failed", runId: run.id }, { status: 500 });
  }
}
