import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { jsonBody } from "@/lib/request";
import { resolveRequestContext } from "@/lib/workspace";
import { validateGraph } from "@/lib/workflows/builder";
import { getWorkflowBuild, type BuildJobDb } from "@/lib/workflows/build-jobs";
import { deriveDisplay, leadLogo, scheduleText, toWorkflowView } from "@/lib/workflows/display";
import { insertWorkflowOnce, listWorkflowRows, OPEN_STATUSES } from "@/lib/workflows/store";
import { getTemplate } from "@/lib/workflows/templates";
import type { RunStatus, WorkflowConfig } from "@/lib/workflows/types";

/**
 * GET  — list the workspace's automations, enriched with run history
 *        (last run, recent statuses) for the list page.
 * POST — create one, from any of the three build paths: an AI preview
 *        (`build`), a template (`template`), or a graph the visual editor
 *        composed (`graph`). All three are re-validated server-side.
 */

interface RunSlice {
  workflow_id: string;
  status: string;
  started_at: string;
  /** Non-null while the run is parked on a machine (a render), not a person. */
  awaiting?: unknown;
}

export async function GET() {
  const ctx = await resolveRequestContext();

  // Demo/preview mode: nothing to list.
  if (!ctx.supabase || !ctx.workspaceId) {
    return NextResponse.json({ workflows: [], demo: true });
  }

  let rows;
  try {
    rows = await listWorkflowRows(ctx.supabase, ctx.workspaceId);
  } catch (err) {
    // Say what went wrong. The page renders this instead of the empty state.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load your automations" },
      { status: 502 },
    );
  }

  // One query for every workflow's recent runs, newest first.
  let runRows: RunSlice[] = [];
  if (rows.length) {
    const { data } = await ctx.supabase
      .from("workflow_runs")
      // `log->awaiting` rather than `log`: the only thing this list needs from
      // a run's journal is whether its wait belongs to a person or a machine,
      // and pulling 300 whole logs to learn one boolean each would be the most
      // expensive query on the page.
      .select("workflow_id, status, started_at, awaiting:log->awaiting")
      .in(
        "workflow_id",
        rows.map((r) => r.id),
      )
      .order("started_at", { ascending: false })
      .limit(300);
    runRows = (data as RunSlice[]) ?? [];
  }
  const byWorkflow = new Map<string, RunSlice[]>();
  for (const run of runRows) {
    const list = byWorkflow.get(run.workflow_id);
    if (list) list.push(run);
    else byWorkflow.set(run.workflow_id, [run]);
  }

  return NextResponse.json({
    workflows: rows.map((row) => {
      const runs = byWorkflow.get(row.id) ?? []; // newest first
      const latest = runs[0];
      return {
        ...toWorkflowView(row),
        createdAt: row.created_at,
        // "Recently edited" sorted by created_at, so editing never reordered
        // anything. Maintained by a DB trigger since 0018.
        updatedAt: row.updated_at ?? row.created_at,
        lastRunAt: latest?.started_at ?? null,
        lastRunStatus: latest?.status ?? null,
        // Runs that have not landed anywhere yet. Counted separately from the
        // success rate so a workflow with nine crashed runs and one good one
        // cannot show 100%.
        openRuns: runs.filter((r) => OPEN_STATUSES.includes(r.status as RunStatus)).length,
        // Runs blocked on a PERSON. Distinct from openRuns because nothing will
        // ever move these on its own — they are the one thing on this page that
        // is genuinely waiting for the user rather than for a machine. A run
        // parked on a video render is `waiting` in the same column and is
        // excluded here for exactly that reason: it moves on its own, and
        // counting it would badge the tab with work nobody can do.
        waitingRuns: runs.filter((r) => r.status === "waiting" && !r.awaiting).length,
        // Statuses oldest→newest, max 12 — the list page's activity sparkline.
        recent: runs
          .slice(0, 12)
          .map((r) => r.status)
          .reverse(),
        logo: leadLogo(row.config?.graph),
      };
    }),
  });
}

export async function POST(req: Request) {
  // Authenticate BEFORE parsing and validating attacker-controlled jsonb.
  // validateGraph walks the whole graph; doing that for an anonymous caller is
  // free CPU for anyone who asks.
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to save automations" }, { status: 401 });
  }

  const body = await jsonBody<{
    prompt?: string;
    buildId?: string;
    template?: string;
    name?: string;
    description?: string;
  }>(req);
  if (!body) {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const suppliedNonce = (req.headers.get("x-workflow-nonce") ?? "").trim();
  const creationKey = suppliedNonce.slice(0, 100) || randomUUID();

  // Resolve whichever build path was used into (name, description, config).
  let name: string;
  let description: string;
  let config: WorkflowConfig;

  if (body.template) {
    const template = getTemplate(body.template);
    if (!template) {
      return NextResponse.json({ error: "Unknown template" }, { status: 400 });
    }
    name = String(body.name ?? template.name).slice(0, 60);
    description = String(body.description ?? template.description).slice(0, 200);
    config = {
      v: 1,
      graph: template.graph,
      display: { groups: deriveDisplay(template.graph) },
    };
  } else if (body.buildId) {
    const job = await getWorkflowBuild(
      ctx.supabase as unknown as BuildJobDb,
      body.buildId,
      ctx.workspaceId,
    );
    const build = job?.status === "completed" ? job.result : null;
    if (!build?.config?.graph) {
      return NextResponse.json({ error: "The workflow build is not ready" }, { status: 409 });
    }
    name = String(build.name ?? "Untitled automation").slice(0, 60);
    description = String(build.description ?? "").slice(0, 200);
    // Build output is loaded from the durable server row rather than trusted
    // from the browser that previewed it.
    config = {
      v: 1,
      graph: build.config.graph,
      display: build.config.display ?? { groups: deriveDisplay(build.config.graph) },
      prompt: build.config.prompt,
    };
  } else {
    return NextResponse.json({ error: "Missing built workflow" }, { status: 400 });
  }

  // Never trust client-supplied jsonb — re-validate before persisting.
  try {
    validateGraph(config.graph);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  const { row, duplicate } = await insertWorkflowOnce(ctx.supabase, {
    workspaceId: ctx.workspaceId,
    name,
    description,
    // ALWAYS paused. `active: !body.template` started every AI-built workflow
    // live the instant it was saved — so a workflow the user had not yet
    // looked at could publish to a real account on the next beat, which is not
    // what the chat copy promises ("switch it on when you're ready").
    active: false,
    schedule: scheduleText(config),
    config,
    creationKey,
  });
  if (!row) {
    return NextResponse.json({ error: "Could not save the workflow" }, { status: 502 });
  }
  return NextResponse.json({ workflow: toWorkflowView(row), duplicate });
}
