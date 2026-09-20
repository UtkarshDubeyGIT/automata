import { NextResponse, type NextRequest } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { brandKnowsProduct, getBrandProfileForWorkspace } from "@/lib/brand";
import {
  connectionsOf,
  needsBrandGrounding,
  requiredAppsOf,
  unconnected,
} from "@/lib/workflows/apps";
import { socialProvider } from "@/lib/social/composio";
import { deriveDisplay, leadLogo, relTime, toWorkflowView } from "@/lib/workflows/display";
import {
  deleteWorkflow,
  getWorkflowRow,
  listRuns,
  setActive,
  updateWorkflow,
} from "@/lib/workflows/store";
import { pendingPreview } from "@/lib/workflows/preview";
import { syncRealtimeTrigger } from "@/lib/workflows/realtime";
import { createAdminClient } from "@/lib/supabase/server";
import { gapCount, setupGaps } from "@/lib/workflows/validate";
import { validateDraftEnvelope, type WorkflowPositions } from "@/lib/workflows/editor";
import type { RunStatus, WorkflowGraph } from "@/lib/workflows/types";
import { firecrawlConfigured } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";
import { serverOwnedRows } from "@/lib/integrations/server-owned-rows";
import { readCachedIntegrations } from "@/lib/social/integrations-store";
import type { RequestContext } from "@/lib/workspace";
import { canActivateWorkflow, isPlanId, PLANS } from "@/lib/billing/plans";

/**
 * One automation.
 *   GET    — the workflow view, its graph (the visual editor's source of
 *            truth), and its run history with per-step journals.
 *   PATCH  — small mutations: the on/off toggle, a rename.
 *   PUT    — save an edited graph from the visual editor.
 *   DELETE — remove it.
 */

const RUN_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  completed: "Completed",
  failed: "Failed",
  running: "Running",
  waiting: "Waiting for review",
};

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rc = await resolveRequestContext();

  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let row;
  let runs;
  try {
    row = await getWorkflowRow(rc.supabase, id);
    if (!row) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    runs = await listRuns(rc.supabase, id);
  } catch (err) {
    // A 404 would say this automation doesn't exist, which is a different and
    // much more alarming thing than "the database didn't answer".
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load this automation" },
      { status: 502 },
    );
  }
  const publishedGraph = row.config?.graph;
  const graph = row.draft_config?.graph ?? publishedGraph;

  return NextResponse.json({
    workflow: { ...toWorkflowView(row), logo: leadLogo(graph) },
    // The editor works on the raw graph; the view above is only for chrome.
    graph,
    positions: row.draft_positions ?? {},
    revision: row.draft_revision ?? 0,
    publishedGraph,
    requiredApps: graph ? requiredAppsOf(graph) : [],
    triggerSample: row.trigger_state?.sample ?? null,
    runs: runs.map((r) => ({
      id: r.id,
      status: r.status,
      label: RUN_LABEL[r.status] ?? r.status,
      time: relTime(r.started_at),
      startedAt: r.started_at,
      error: r.log?.error ?? null,
      // WHICH step stopped it. The journal cannot say — a failing step is never
      // journaled — so the canvas's red `x` had no data to render from.
      failedStepId: r.log?.failed?.stepId ?? null,
      // What this run is waiting for, so the Runs tab can offer the decision —
      // and WHAT is being decided on, so it can be read before deciding.
      pending: r.log?.pending
        ? {
            stepId: r.log.pending.stepId,
            prompt: r.log.pending.prompt,
            preview: pendingPreview(r.log, graph),
          }
        : null,
      // Waiting on a render, not on a person — see the runs endpoint.
      awaiting: r.log?.awaiting
        ? { kind: r.log.awaiting.kind, note: r.log.awaiting.note, since: r.log.awaiting.since }
        : null,
      // Per-step journal — the Runs tab expands this into a timeline.
      journal: (r.log?.journal ?? []).map((entry) => ({
        stepId: entry.stepId,
        type: entry.type,
        title: entry.title,
        at: entry.at,
        output: entry.output,
      })),
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { active?: boolean; name?: string; description?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ ok: true, active: body.active, demo: true });
  }

  // Switching an automation ON is a promise that it can actually run — refuse
  // while any step is still missing required configuration.
  if (body.active === true) {
    const row = await getWorkflowRow(rc.supabase, id);

    // Draft auto-save is intentionally not permission to run it. The visible
    // Save is the only action that commits a draft as the runnable version, so
    // direct API callers must meet the same boundary as the editor.
    const draftGraph = row?.draft_config?.graph ?? row?.config?.graph;
    const committedGraph = row?.config?.graph;
    if (JSON.stringify(draftGraph ?? null) !== JSON.stringify(committedGraph ?? null)) {
      return NextResponse.json(
        {
          error: "The latest draft must be saved before this automation can be switched on.",
          code: "save_first",
        },
        { status: 409 },
      );
    }

    // Plan gate: an already-active workflow re-sending `active: true` is a
    // no-op and must not get caught by its own count. A workflow that isn't
    // active yet only counts every OTHER currently active workflow.
    if (!row?.active) {
      const { data: ws } = await rc.supabase
        .from("workspaces")
        .select("plan")
        .eq("id", rc.workspaceId)
        .maybeSingle();
      const planId = ws?.plan && isPlanId(ws.plan) ? ws.plan : "free";
      const { count } = await rc.supabase
        .from("workflows")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", rc.workspaceId)
        .eq("active", true);
      if (!canActivateWorkflow(planId, count ?? 0)) {
        const limit = PLANS[planId].activeWorkflowLimit;
        return NextResponse.json(
          {
            error: `Your plan allows ${limit} active automation${limit === 1 ? "" : "s"} at a time — pause one or upgrade to activate another.`,
            code: "plan_limit",
          },
          { status: 409 },
        );
      }
    }

    const gaps = row?.config?.graph ? setupGaps(row.config.graph) : {};
    const pending = gapCount(gaps);
    if (pending) {
      // The switch runs the PUBLISHED graph. When the draft already fills
      // every gap, "Fill in project_id" points at a field the user can see is
      // filled — the missing step is Publish, so say that instead.
      const draftGraph = row?.draft_config?.graph;
      const publishFirst = !!draftGraph && gapCount(setupGaps(draftGraph)) === 0;
      return NextResponse.json(
        {
          error: publishFirst
            ? "Publish your draft first — the published version still needs setup."
            : `${pending} step${pending > 1 ? "s" : ""} still need${pending > 1 ? "" : "s"} setup`,
          gaps,
          publishFirst,
        },
        { status: 409 },
      );
    }

    // Same promise, the other half of it: an account nobody ever connected
    // fails just as certainly as a blank field, one step later, and every
    // create path now asks for those accounts up front — so the switch should
    // not be the one place that still lets it through. The editor gates this
    // client-side too; this is what makes it true of any caller.
    const missing = await unconnectedApps(rc, row?.config?.graph);
    if (missing.length) {
      return NextResponse.json(
        {
          error: `Connect ${missing.map((a) => a.label).join(" and ")} first — runs stop at the first step that needs it.`,
          disconnected: missing.map((a) => a.app),
        },
        { status: 409 },
      );
    }

    /*
     * The third half of the same promise: an automation that generates copy or
     * images for a workspace we know nothing about does run, and that is the
     * problem — it publishes competent, on-schedule writing about nobody in
     * particular, to a real account, unattended, until somebody reads it.
     *
     * This deliberately reverses an earlier decision to keep the brand gap a
     * non-blocking nudge. The nudge was correct while the only fix lived on
     * another team's roadmap; now that Settings can re-scan the site and run
     * the research, there is a fix the message can point at, and letting
     * someone schedule generic posts to their own audience is not a kindness.
     * It is NOT a `setupGaps` entry, though — that stays pure and per-step, and
     * this is a workspace-wide fact about a graph whose every field is filled.
     *
     * Fails OPEN, like the Composio check above: a profile read that throws
     * must not lock anyone out of their own automation.
     */
    if (row?.config?.graph && needsBrandGrounding(row.config.graph)) {
      let knows = true;
      try {
        knows = brandKnowsProduct(await getBrandProfileForWorkspace(rc.workspaceId));
      } catch (err) {
        console.error("[workflows] brand profile read failed:", err);
      }
      if (!knows) {
        return NextResponse.json(
          {
            error:
              "Tell us what your business does first — this automation writes with AI, and with an empty profile every run publishes generalities. Settings → Brand voice.",
            brandGap: true,
          },
          { status: 409 },
        );
      }
    }
  }

  if (typeof body.active === "boolean" && body.name === undefined && body.description === undefined) {
    await setActive(rc.supabase, id, body.active);
    const realtime = await syncRealtime(rc.supabase, id, body.active);
    return NextResponse.json({ ok: true, active: body.active, realtime });
  }

  const row = await updateWorkflow(rc.supabase, id, {
    active: body.active,
    name: body.name?.slice(0, 60),
    description: body.description?.slice(0, 200),
  });
  if (!row) return NextResponse.json({ error: "Could not update" }, { status: 502 });
  const realtime =
    typeof body.active === "boolean" ? await syncRealtime(rc.supabase, id, body.active) : undefined;
  return NextResponse.json({ ok: true, workflow: toWorkflowView(row), realtime });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { graph?: WorkflowGraph; positions?: WorkflowPositions; baseRevision?: number; name?: string; description?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (!body.graph) return NextResponse.json({ error: "Missing workflow graph" }, { status: 400 });
  const graph = body.graph;
  const positions = body.positions ?? {};
  const envelopeErrors = validateDraftEnvelope(graph, positions);
  if (envelopeErrors.length) return NextResponse.json({ error: envelopeErrors[0] }, { status: 400 });
  if (!Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 0) {
    return NextResponse.json({ error: "baseRevision is required" }, { status: 400 });
  }

  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to save changes" }, { status: 401 });
  }

  const existing = await getWorkflowRow(rc.supabase, id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const draftConfig = {
    ...(existing.draft_config ?? existing.config),
    v: 1,
    graph,
    display: { groups: deriveDisplay(graph) },
  };
  if (hasFirecrawlStep(graph) && !firecrawlConfigured) {
    return NextResponse.json(
      {
        error: setupNotice(
          "Web research isn't available yet, so this automation can't be saved. Please try again later.",
          "FIRECRAWL_API_KEY is not set, so web research steps cannot run.",
        ),
        code: "firecrawl_unavailable",
      },
      { status: 409 },
    );
  }
  const nextRevision = Number(body.baseRevision) + 1;
  const { data: saved, error } = await rc.supabase
    .from("workflows")
    .update({
      draft_config: draftConfig,
      draft_positions: positions,
      draft_revision: nextRevision,
      draft_updated_by: rc.userId,
      ...(body.name?.trim() ? { name: body.name.trim().slice(0, 60) } : {}),
      ...(body.description !== undefined ? { description: body.description.slice(0, 200) } : {}),
    })
    .eq("id", id)
    .eq("draft_revision", body.baseRevision)
    .select("id, name, description, active, schedule, config, draft_config, draft_positions, draft_revision, draft_updated_by, trigger_state, runs, success_rate, last_run_at, created_at, updated_at")
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!saved) return NextResponse.json({ error: "revision_conflict", code: "revision_conflict" }, { status: 409 });
  const row = saved as typeof existing;

  return NextResponse.json({
    workflow: { ...toWorkflowView(row), logo: leadLogo(graph) },
    graph,
    positions,
    revision: nextRevision,
    requiredApps: requiredAppsOf(graph),
    gaps: setupGaps(graph),
  });
}

/**
 * Accounts this graph needs that the workspace has not connected.
 *
 * Fails OPEN on purpose. Composio being unreachable is our problem, not a
 * reason to refuse to switch on an automation whose accounts may well be
 * fine — the run itself still pre-checks the connection (`steps.ts`) and
 * fails with the same sentence if they aren't.
 */
async function unconnectedApps(rc: RequestContext, graph?: WorkflowGraph) {
  if (!graph || !rc.entityId) return [];
  const required = requiredAppsOf(graph);
  // Apps we host ourselves (web research, Vikunja, Business Profile) are
  // absent from every Composio listing: their status is our own server's
  // answer, the same one the status endpoint gives the editor.
  const own = await serverOwnedRows(rc, await readCachedIntegrations(rc));
  if (!socialProvider.live) {
    return unconnected(connectionsOf(required, own, false));
  }
  try {
    const rows = await socialProvider.listConnections(rc.entityId);
    return unconnected(connectionsOf(required, [...rows, ...own], true));
  } catch {
    return unconnected(connectionsOf(required, own, false));
  }
}

function hasFirecrawlStep(graph: WorkflowGraph): boolean {
  return Object.values(graph.steps).some((step) => step.type === "firecrawl");
}

/**
 * Bring the real-time watch in line with the switch that was just flipped.
 *
 * Deliberately never throws: whether Composio will watch an account for us is
 * not a reason to refuse to pause an automation. Whatever it can't arrange
 * comes back as a reason on the workflow's trigger state, and the sweep keeps
 * polling.
 */
async function syncRealtime(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { from(table: string): any },
  id: string,
  active: boolean,
) {
  try {
    const { data } = await db
      .from("workflows")
      .select("id, workspace_id, config, trigger_state")
      .eq("id", id)
      .maybeSingle();
    if (!data) return undefined;
    // The RLS client proved ownership above; the write goes through the admin
    // client because trigger_state is engine bookkeeping, not user data.
    return await syncRealtimeTrigger(createAdminClient(), data, active);
  } catch (err) {
    console.error("[workflows] real-time sync failed:", err);
    return undefined;
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to delete automations" }, { status: 401 });
  }
  // Stop the watch BEFORE the row goes, or Composio keeps pushing events for
  // an automation that no longer exists.
  await syncRealtime(rc.supabase, id, false);
  await deleteWorkflow(rc.supabase, id);
  return NextResponse.json({ ok: true });
}
