import { randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { jsonBody } from "@/lib/request";
import { resolveRequestContext, type RequestContext, type ServerSupabase } from "@/lib/workspace";
import { validateGraph } from "@/lib/workflows/builder";
import { claimWorkflowDraft, getWorkflowBuild, type BuildJobDb, type WorkflowBuildJob } from "@/lib/workflows/build-jobs";
import { deriveDisplay, leadLogo, scheduleText, toWorkflowView } from "@/lib/workflows/display";
import { insertWorkflowOnce, listWorkflowRows, OPEN_STATUSES } from "@/lib/workflows/store";
import { getTemplate } from "@/lib/workflows/templates";
import type { RunStatus, WorkflowConfig } from "@/lib/workflows/types";
import { firecrawlConfigured } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";
import { liveWrites } from "@/lib/workflows/validate";
import { createAdminClient } from "@/lib/supabase/server";
import { recordWorkflowBuildEvent } from "@/lib/workflows/diagnostics";

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
  /** Non-null while the run is parked on machine work, not a person. */
  awaiting?: unknown;
}

interface CreateWorkflowBody {
  prompt?: string;
  buildId?: string;
  expectedRevision?: string;
  template?: string;
  name?: string;
  description?: string;
}

type SaveContext = RequestContext & { supabase: ServerSupabase; workspaceId: string };

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
        // parked on machine work is `waiting` in the same column and is
        // excluded here for exactly that reason: it moves on its own, and
        // counting it would badge the tab with work nobody can do.
        waitingRuns: runs.filter((r) => r.status === "waiting" && !r.awaiting).length,
        // Statuses oldest→newest, max 12 — the list page's activity sparkline.
        recent: runs
          .slice(0, 12)
          .map((r) => r.status)
          .reverse(),
        logo: leadLogo(row.config?.graph),
        // The list can switch a workflow on without first opening the editor.
        // Send only the human-facing write labels needed for that confirmation,
        // never the graph or provider arguments themselves.
        externalActions: row.config?.graph ? liveWrites(row.config.graph) : [],
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

  const body = await jsonBody<CreateWorkflowBody>(req);
  if (!body) {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  if (body.buildId !== undefined) {
    if (typeof body.buildId !== "string" || !body.buildId.trim()) {
      return NextResponse.json({ error: "Invalid workflow build ID" }, { status: 400 });
    }
    body.buildId = body.buildId.trim();
  }
  const suppliedNonce = (req.headers.get("x-workflow-nonce") ?? "").trim();
  const creationKey = suppliedNonce.slice(0, 100) || randomUUID();
  const saveContext: SaveContext = { ...ctx, supabase: ctx.supabase, workspaceId: ctx.workspaceId };

  if (!body.buildId) return saveWorkflow(saveContext, body, creationKey);
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Workflow saving is unavailable" }, { status: 503 });
  }
  const lock = await claimWorkflowDraft(admin as unknown as BuildJobDb, body.buildId);
  if (!lock.ok) {
    return NextResponse.json({ error: "This draft is being edited or saved. Try again shortly." }, { status: 409 });
  }
  try {
    return await saveWorkflow(saveContext, body, creationKey);
  } finally {
    await lock.release();
  }
}

async function saveWorkflow(ctx: SaveContext, body: CreateWorkflowBody, creationKey: string) {
  // Resolve whichever build path was used into (name, description, config).
  let name: string;
  let description: string;
  let config: WorkflowConfig;
  let buildJob: WorkflowBuildJob | null = null;

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
    if (!body.expectedRevision || body.expectedRevision !== job?.updated_at) {
      return NextResponse.json({ error: "This draft changed after the preview. Refresh it before saving." }, { status: 409 });
    }
    buildJob = job;
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

  // Web research runs on the app's own Firecrawl key. Nothing a workspace can
  // connect changes this, so an unset server key is the only failure mode.
  if (hasFirecrawlStep(config.graph) && !firecrawlConfigured) {
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

  // Reaching this point means the owner accepted the durable preview and the
  // server has re-validated the graph. Keep that milestone distinct from the
  // later workflow-created event so support can separate a discarded/failed
  // save from a build that never reached preview.
  if (buildJob) {
    void recordWorkflowBuildEvent(createAdminClient(), {
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      buildJobId: buildJob.id,
      correlationId: buildJob.correlation_id,
      eventType: "preview_accepted",
      stage: "preview",
      eventKey: `${buildJob.id}:preview_accepted`,
      metadata: { creationKey },
    });
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
    void recordWorkflowBuildEvent(createAdminClient(), {
      workspaceId: ctx.workspaceId,
      actorId: ctx.userId,
      buildJobId: buildJob?.id,
      correlationId: buildJob?.correlation_id,
      eventType: "workflow_creation_failed",
      stage: "save",
      level: "error",
      eventKey: `${buildJob?.id ?? creationKey}:workflow_creation_failed`,
      metadata: { creationKey },
    });
    return NextResponse.json({ error: "Could not save the workflow" }, { status: 502 });
  }
  void recordWorkflowBuildEvent(createAdminClient(), {
    workspaceId: ctx.workspaceId,
    actorId: ctx.userId,
    buildJobId: buildJob?.id,
    correlationId: buildJob?.correlation_id,
    eventType: duplicate ? "workflow_creation_duplicate" : "workflow_created",
    stage: "save",
    eventKey: `${buildJob?.id ?? creationKey}:${duplicate ? "workflow_creation_duplicate" : "workflow_created"}`,
    metadata: { creationKey, workflowId: row.id },
  });
  return NextResponse.json({ workflow: toWorkflowView(row), duplicate });
}

function hasFirecrawlStep(config: WorkflowConfig["graph"]): boolean {
  return Object.values(config.steps).some((step) => step.type === "firecrawl");
}
