import { NextResponse, type NextRequest } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { leadLogo, relTime } from "@/lib/workflows/display";
import { pendingPreview } from "@/lib/workflows/preview";
import { listWorkflowRows, normalizeLog } from "@/lib/workflows/store";
import type { RunStatus } from "@/lib/workflows/types";

/**
 * Every recent run in the workspace, newest first — the Runs history tab.
 *
 * The list endpoint already reads runs, but only their statuses, and only to
 * fold them into a per-workflow summary (last run, sparkline, counts). A run
 * history is the opposite shape: one row per run, across automations, carrying
 * what that run actually did. Deriving it client-side from the list is not
 * possible, and fetching /api/workflows/[id] once per automation to assemble
 * it would be N requests for one screen.
 *
 * It also answers "what is blocked on me": a `waiting` run carries the prompt
 * it is waiting on, which is the only place the decision text exists outside
 * the run's own log.
 *
 * (Static segment, so it takes precedence over /api/workflows/[id]. Workflow
 * ids are UUIDs, so nothing can be shadowed by it.)
 */
export const dynamic = "force-dynamic";

const RUN_LABEL: Record<RunStatus, string> = {
  queued: "Queued",
  running: "Running",
  // `waiting` says nothing about WHO is being waited on — a run parked on a
  // render is relabelled below, where the log can say which it is.
  waiting: "Waiting for review",
  completed: "Succeeded",
  failed: "Failed",
};

/** Newest N runs. Enough for "recent history" without paging the whole table. */
const DEFAULT_LIMIT = 60;
const MAX_LIMIT = 200;

interface RunSlice {
  id: string;
  workflow_id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  log: unknown;
}

/** How long the run took, once it has finished. */
function took(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export async function GET(req: NextRequest) {
  const ctx = await resolveRequestContext();

  // Demo/preview mode: nothing to list.
  if (!ctx.supabase || !ctx.workspaceId) {
    return NextResponse.json({ runs: [], demo: true });
  }

  // `Number("")` is 0, so a bare `?limit=` used to clamp to a single run
  // rather than falling back to the default.
  const raw = req.nextUrl.searchParams.get("limit");
  const asked = raw ? Number(raw) : NaN;
  const limit = Number.isFinite(asked) && asked > 0
    ? Math.min(Math.trunc(asked), MAX_LIMIT)
    : DEFAULT_LIMIT;

  let rows;
  try {
    rows = await listWorkflowRows(ctx.supabase, ctx.workspaceId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not load your runs" },
      { status: 502 },
    );
  }
  if (!rows.length) return NextResponse.json({ runs: [] });

  // The name and logo live on the workflow, not the run, so carry them across
  // here rather than making the client join two responses.
  // The graph rides along too: a run that was already waiting before previews
  // existed has no snapshot of its own, and this is what lets one be derived
  // for it rather than showing the bare prompt forever.
  const parents = new Map(
    rows.map((row) => [
      row.id,
      { name: row.name, logo: leadLogo(row.config?.graph), graph: row.config?.graph },
    ]),
  );

  // RLS scopes workflow_runs through the parent workflow, so this is already
  // this workspace's runs — the `in` is what keeps the ordering useful.
  const { data, error } = await ctx.supabase
    .from("workflow_runs")
    .select("id, workflow_id, status, started_at, finished_at, log")
    .in("workflow_id", [...parents.keys()])
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    return NextResponse.json({ error: "Could not load your runs" }, { status: 502 });
  }

  return NextResponse.json({
    runs: ((data as RunSlice[]) ?? []).map((run) => {
      const parent = parents.get(run.workflow_id);
      const log = normalizeLog(run.log);
      const status = run.status as RunStatus;
      return {
        id: run.id,
        workflowId: run.workflow_id,
        workflowName: parent?.name ?? "Automation",
        logo: parent?.logo ?? null,
        status,
        label: log.awaiting
          ? log.awaiting.kind === "firecrawl"
            ? "Researching"
            : "Rendering"
          : (RUN_LABEL[status] ?? run.status),
        startedAt: run.started_at,
        time: relTime(run.started_at),
        took: took(run.started_at, run.finished_at),
        steps: log.journal?.length ?? 0,
        error: log.error ?? null,
        // What this run is blocked on, so the page can offer the decision
        // without opening the automation first — and, with `preview`, what it
        // would actually send, so the decision can be made on the content
        // rather than on trust.
        pending: log.pending
          ? {
              stepId: log.pending.stepId,
              prompt: log.pending.prompt,
              preview: pendingPreview(log, parent?.graph),
            }
          : null,
        // Parked on a machine rather than a person. Same `waiting` status,
        // opposite meaning: nothing here is anybody's decision, so the page
        // reports it as work in progress and keeps it out of the list of
        // things demanding attention.
        awaiting: log.awaiting
          ? {
              kind: log.awaiting.kind,
              operation: log.awaiting.operation,
              note: log.awaiting.note,
              since: log.awaiting.since,
            }
          : null,
      };
    }),
  });
}
