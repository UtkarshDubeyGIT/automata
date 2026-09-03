import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveRequestContext } from "@/lib/workspace";
import { claimForDriving, driveRun } from "@/lib/workflows/claim";
import { getWorkflowRow, normalizeLog } from "@/lib/workflows/store";
import type { RunStatus } from "@/lib/workflows/types";

/**
 * Approve or reject a run waiting on a human.
 *
 * It records the decision, then FINISHES the run in-request.
 *
 * This originally only re-queued it and left the beat to resume — on the
 * reasoning that a resumed approval publishes, and publishing is the
 * unattended irreversible work that belongs off the request path. That
 * reasoning does not survive contact with the actual moment: an approval click
 * is the least unattended event in the system. A person just authorised this
 * exact post and is watching for it. Queueing meant Approve appeared to do
 * nothing for up to a full beat interval — and on a machine with no beat at
 * all, the run sat until the reclaim failed and refunded it an hour later.
 *
 * So it drives the run here, but keeps every guarantee that made queueing
 * attractive:
 *
 *  - The SAME compare-and-swap the drain uses, so a beat and this request can
 *    never both drive one run and execute the publish twice.
 *  - The run's own graph snapshot, so it replays against what it was claimed
 *    with rather than whatever the editor has saved since.
 *  - Every step journaled, so a request cut off mid-publish leaves a resumable
 *    run the next beat picks up — nothing is lost and nothing repeats.
 *
 * Deciding twice is a no-op, not a second run.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; runId: string }> },
) {
  const { id, runId } = await ctx.params;

  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to review runs" }, { status: 401 });
  }
  // Ownership: the RLS client can only see workflows in the caller's workspace.
  const workflow = await getWorkflowRow(rc.supabase, id);
  if (!workflow) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: { decision?: string; note?: string };
  try {
    body = (await req.json()) as { decision?: string; note?: string };
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const decision = body.decision === "approve" ? "approve" : body.decision === "reject" ? "reject" : null;
  if (!decision) {
    return NextResponse.json({ error: "Decide either 'approve' or 'reject'" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("workflow_runs")
    .select("id, status, log, workflow_id")
    .eq("id", runId)
    .eq("workflow_id", id)
    .maybeSingle();
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const status = data.status as RunStatus;
  if (status !== "waiting") {
    // Already decided, already finished, or never asked. Report where it got
    // to rather than starting anything.
    return NextResponse.json({ ok: true, status, alreadyResolved: true });
  }

  const log = normalizeLog(data.log);
  const stepId = log.pending?.stepId;
  if (!stepId) {
    return NextResponse.json(
      { error: "This run isn't waiting on a decision." },
      { status: 409 },
    );
  }

  log.context.decisions = {
    ...(log.context.decisions ?? {}),
    [stepId]: {
      decision,
      note: String(body.note ?? "").slice(0, 500) || undefined,
      at: new Date().toISOString(),
    },
  };

  // `.eq("status", "waiting")` makes this the compare-and-swap that decides a
  // double-click: only the first press moves the run, the second finds it
  // already queued and changes nothing.
  const { data: moved, error } = await admin
    .from("workflow_runs")
    .update({ status: "queued", log, claimed_at: null })
    .eq("id", runId)
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: "Could not record that decision" }, { status: 502 });
  }
  if (!moved) {
    return NextResponse.json({ ok: true, status: "queued", alreadyResolved: true });
  }

  // Win the row, then finish the run. Losing the CAS is not an error: it means
  // a beat picked it up in the last instant and is driving it right now.
  const claimed = await claimForDriving(admin, runId);
  if (!claimed?.graph?.start) {
    return NextResponse.json({ ok: true, status: "queued", decision, stepId });
  }

  const result = await driveRun(admin, {
    id: runId,
    workflowId: id,
    // Ownership was proved by the RLS read above, so this is the right entity
    // for the Composio calls the remaining steps make.
    workspaceId: rc.workspaceId,
    graph: claimed.graph,
    log: claimed.log,
  });

  return NextResponse.json({
    ok: true,
    status: result.status,
    error: result.error,
    decision,
    stepId,
  });
}
