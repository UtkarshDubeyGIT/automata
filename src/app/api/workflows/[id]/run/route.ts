import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { resolveRequestContext } from "@/lib/workspace";
import { claimRun, manualKey, RUN_COST } from "@/lib/workflows/claim";
import { getWorkflowRow } from "@/lib/workflows/store";
import { draftIssues } from "@/lib/workflows/editor";
import { repairRefs } from "@/lib/workflows/repair";
import { setupGaps, validateGraph } from "@/lib/workflows/validate";

/**
 * Run now — the Run button.
 *
 * This is the ONE path that still executes in-request: a human is watching it,
 * and the button has to stay synchronous to be worth pressing. Everything
 * unattended enqueues instead (see claim.ts). The charge, the idempotency key
 * and the graph snapshot all live in claimRun, so this route is now only
 * authentication plus a response shape.
 *
 * The key comes from the UI, which mints one per ATTEMPT and keeps re-sending
 * it until this route actually answers (see lib/workflows/run-request.ts). That
 * is what makes a retried fetch, a proxy 504 on a run that is still going, and
 * the impatient second press that follows it one run and one charge rather than
 * two of each. A press made after an answer arrived carries a new key, because
 * by then a second run is genuinely what was asked for.
 */
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rc = await resolveRequestContext();

  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to run automations" }, { status: 401 });
  }

  const row = await getWorkflowRow(rc.supabase, id);
  if (!row) {
    return NextResponse.json({ error: "Automation not found" }, { status: 404 });
  }
  const candidate = row.draft_config?.graph ?? row.config?.graph;
  if (!candidate?.start) {
    return NextResponse.json({ error: "This automation has no runnable graph" }, { status: 400 });
  }
  const { graph } = repairRefs(candidate);
  try {
    validateGraph(graph);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "The saved draft is not runnable" }, { status: 400 });
  }
  const issues = draftIssues(graph);
  const gaps = setupGaps(graph);
  if (issues.length || Object.values(gaps).some((items) => items.length)) {
    return NextResponse.json({ error: issues[0]?.message ?? "Finish configuring this draft before running it" }, { status: 400 });
  }

  // A missing nonce still gets a unique key: an old client that doesn't send
  // one behaves exactly as it did before rather than colliding with itself.
  const nonce = (req.headers.get("x-run-nonce") ?? "").trim().slice(0, 100) || randomUUID();

  const claim = await claimRun({
    admin: createAdminClient(),
    workflowId: id,
    workspaceId: rc.workspaceId,
    graph,
    idempotencyKey: manualKey(nonce),
    mode: "execute",
  });

  if (claim.refused?.reason === "insufficient_credits") {
    return NextResponse.json(
      { error: "Not enough credits", balance: claim.refused.balance, cost: RUN_COST },
      { status: 402 },
    );
  }
  if (claim.refused) {
    return NextResponse.json({ error: claim.error }, { status: 502 });
  }

  return NextResponse.json({
    run: { runId: claim.runId, status: claim.status, error: claim.error },
    // The same click arriving twice gets the first run back, not a second one.
    duplicate: claim.duplicate,
  });
}
