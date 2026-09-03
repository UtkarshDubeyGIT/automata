import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveRequestContext } from "@/lib/workspace";
import { claimForDriving, driveRun } from "@/lib/workflows/claim";
import { normalizeLog } from "@/lib/workflows/store";
import type { RunStatus } from "@/lib/workflows/types";

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to decide an approval." }, { status: 401 });
  }

  const { id } = await params;
  const body = (await request.json().catch(() => ({}))) as { decision?: string; note?: string };
  const rawDecision = body.decision === "approved" || body.decision === "approve" ? "approve" : body.decision === "rejected" || body.decision === "reject" ? "reject" : null;
  if (!rawDecision) {
    return NextResponse.json({ error: "Decision must be approve or reject." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: approval } = await admin
    .from("approvals")
    .select("id, status, run_id, workspace_id")
    .eq("id", id)
    .maybeSingle();

  const runId = approval?.run_id ?? id;

  const { data: runRow } = await admin
    .from("workflow_runs")
    .select("id, status, log, workflow_id, workspace_id")
    .eq("id", runId)
    .maybeSingle();

  if (!runRow) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const status = runRow.status as RunStatus;
  if (status !== "waiting") {
    return NextResponse.json({ ok: true, status, alreadyResolved: true });
  }

  const log = normalizeLog(runRow.log);
  const stepId = log.pending?.stepId ?? "approval";

  log.context.decisions = {
    ...(log.context.decisions ?? {}),
    [stepId]: {
      decision: rawDecision,
      note: String(body.note ?? "").slice(0, 500) || undefined,
      at: new Date().toISOString(),
    },
  };

  const { data: moved, error } = await admin
    .from("workflow_runs")
    .update({ status: "queued", log, claimed_at: null })
    .eq("id", runId)
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: "Could not record decision" }, { status: 502 });
  }
  if (!moved) {
    return NextResponse.json({ ok: true, status: "queued", alreadyResolved: true });
  }

  const claimed = await claimForDriving(admin, runId);
  if (!claimed?.graph?.start) {
    return NextResponse.json({ ok: true, status: "queued", decision: rawDecision, stepId });
  }

  const result = await driveRun(admin, {
    id: runId,
    workflowId: runRow.workflow_id,
    workspaceId: runRow.workspace_id ?? rc.workspaceId,
    graph: claimed.graph,
    log: claimed.log,
  });

  return NextResponse.json({
    ok: true,
    status: result.status,
    error: result.error,
    decision: rawDecision,
    stepId,
  });
}
