import { randomUUID } from "crypto";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from(table: string): any };
import type { RunStore } from "./engine";
import type { RunLog, RunStatus, TriggerState, WorkflowConfig } from "./types";
import type { WorkflowRow } from "./display";

/**
 * DB access for workflows + runs. The `workflows`/`workflow_runs` tables are
 * RLS-protected (owner-only via the parent workspace), so page-facing reads
 * and writes use the request's RLS client; the engine's mid-run writes use
 * the admin client (they must not depend on request cookies).
 */

const ROW_COLUMNS =
  "id, name, description, active, schedule, config, draft_config, draft_positions, draft_revision, draft_updated_by, trigger_state, runs, success_rate, " +
  "last_run_at, created_at, updated_at";

/**
 * A read that fails must not come back as "you have none".
 *
 * These discarded their error, so an unapplied migration, an expired session
 * or a database outage all arrived at the page as an empty array — and the
 * list page renders an empty array as "No automations yet". That is the same
 * defect this whole change is about: reporting something that isn't true.
 */
function orThrow<T>(what: string, result: { data: unknown; error: { message: string } | null }): T {
  if (result.error) throw new Error(`Could not load ${what}: ${result.error.message}`);
  return result.data as T;
}

export async function listWorkflowRows(
  db: DbClient,
  workspaceId: string,
): Promise<WorkflowRow[]> {
  const result = await db
    .from("workflows")
    .select(ROW_COLUMNS)
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  return orThrow<WorkflowRow[] | null>("your automations", result) ?? [];
}

export async function getWorkflowRow(
  db: DbClient,
  id: string,
): Promise<WorkflowRow | null> {
  const result = await db
    .from("workflows")
    .select(ROW_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  return orThrow<WorkflowRow | null>("this automation", result) ?? null;
}

interface InsertWorkflowFields {
  workspaceId: string;
  name: string;
  description: string;
  active: boolean;
  schedule: string;
  config: WorkflowConfig;
  /** Stable identity for one user-intended creation attempt. */
  creationKey?: string;
}

export async function insertWorkflowOnce(
  db: DbClient,
  fields: InsertWorkflowFields,
): Promise<{ row: WorkflowRow | null; duplicate: boolean }> {
  const { data, error } = await db
    .from("workflows")
    .insert({
      workspace_id: fields.workspaceId,
      name: fields.name,
      description: fields.description,
      active: fields.active,
      schedule: fields.schedule,
      config: fields.config,
      draft_config: fields.config,
      draft_positions: {},
      draft_revision: 1,
      ...(fields.creationKey ? { creation_key: fields.creationKey } : {}),
    })
    .select(ROW_COLUMNS)
    .maybeSingle();
  if (error?.code === "23505" && fields.creationKey) {
    const existing = await db
      .from("workflows")
      .select(ROW_COLUMNS)
      .eq("workspace_id", fields.workspaceId)
      .eq("creation_key", fields.creationKey)
      .maybeSingle();
    return {
      row: orThrow<WorkflowRow | null>("the workflow already created", existing) ?? null,
      duplicate: true,
    };
  }
  if (error) throw new Error(`Could not save the automation: ${error.message}`);
  return { row: (data as WorkflowRow) ?? null, duplicate: false };
}

export async function insertWorkflow(
  db: DbClient,
  fields: InsertWorkflowFields,
): Promise<WorkflowRow | null> {
  return (await insertWorkflowOnce(db, fields)).row;
}

export async function setActive(
  db: DbClient,
  id: string,
  active: boolean,
): Promise<void> {
  await db.from("workflows").update({ active }).eq("id", id);
}

/**
 * Persist an edit from the visual editor (or an AI edit). The caller has
 * already validated the graph and re-derived the display + schedule, so this
 * writes exactly what it is given — RLS scopes it to the owner's workspace.
 */
export async function updateWorkflow(
  db: DbClient,
  id: string,
  fields: {
    name?: string;
    description?: string;
    schedule?: string;
    active?: boolean;
    config?: WorkflowConfig;
    trigger_state?: TriggerState;
  },
): Promise<WorkflowRow | null> {
  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.description !== undefined) patch.description = fields.description;
  if (fields.schedule !== undefined) patch.schedule = fields.schedule;
  if (fields.active !== undefined) patch.active = fields.active;
  if (fields.config !== undefined) patch.config = fields.config;
  if (fields.trigger_state !== undefined) patch.trigger_state = fields.trigger_state;
  if (!Object.keys(patch).length) return getWorkflowRow(db, id);

  const { data } = await db
    .from("workflows")
    .update(patch)
    .eq("id", id)
    .select(ROW_COLUMNS)
    .maybeSingle();
  return (data as WorkflowRow) ?? null;
}

export async function deleteWorkflow(db: DbClient, id: string): Promise<void> {
  await db.from("workflows").delete().eq("id", id);
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface RunRow {
  id: string;
  status: RunStatus;
  started_at: string;
  finished_at: string | null;
  log: RunLog;
}

export async function listRuns(
  db: DbClient,
  workflowId: string,
  limit = 10,
): Promise<RunRow[]> {
  const result = await db
    .from("workflow_runs")
    .select("id, status, started_at, finished_at, log")
    .eq("workflow_id", workflowId)
    .order("started_at", { ascending: false })
    .limit(limit);
  return orThrow<RunRow[] | null>("this automation's runs", result) ?? [];
}

/**
 * What this step wrote on its last few completed runs, newest first.
 *
 * Only the AI node uses this, and only to avoid repeating itself. A manual or
 * schedule trigger contributes no data, so every run of such a workflow sends
 * the model an identical prompt — four consecutive runs of one automation
 * opened with the same sentence. Showing the model what it already said is the
 * only signal that actually differs between those runs.
 *
 * Best-effort by contract: every failure returns `[]` rather than throwing. A
 * run must never fail because its own history could not be read.
 */
export async function recentStepOutputs(
  admin: DbClient,
  runId: string,
  stepId: string,
  limit = 3,
): Promise<string[]> {
  try {
    const { data: current } = await admin
      .from("workflow_runs")
      .select("workflow_id")
      .eq("id", runId)
      .maybeSingle();
    const workflowId = (current as { workflow_id?: string } | null)?.workflow_id;
    if (!workflowId) return [];

    // Over-fetch: the newest rows include this run and any that failed before
    // reaching this step, and neither has an output to learn from.
    const { data } = await admin
      .from("workflow_runs")
      .select("id, log")
      .eq("workflow_id", workflowId)
      .neq("id", runId)
      .order("started_at", { ascending: false })
      .limit(limit + 5);

    const out: string[] = [];
    for (const row of (data as { id: string; log: unknown }[] | null) ?? []) {
      for (const entry of normalizeLog(row.log).journal) {
        if (entry.stepId !== stepId) continue;
        const text = stepOutputText(entry.output);
        if (text) out.push(text);
        break;
      }
      if (out.length >= limit) break;
    }
    return out;
  } catch (err) {
    console.error("[workflows] could not read previous outputs:", err);
    return [];
  }
}

/** The human-readable payload of a step output, whether it ran in text or json mode. */
function stepOutputText(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const o = output as Record<string, unknown>;
  if (typeof o.text === "string" && o.text.trim()) return o.text.trim();
  const result = o.result;
  if (result && typeof result === "object") {
    for (const value of Object.values(result as Record<string, unknown>)) {
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

/** Engine persistence backed by Supabase (admin client — trusted writes). */
export function dbRunStore(admin: DbClient): RunStore {
  return {
    async createRun(workflowId, log) {
      const { data, error } = await admin
        .from("workflow_runs")
        .insert({ workflow_id: workflowId, status: "running", log, claimed_at: new Date().toISOString() })
        .select("id")
        .single();
      if (error || !data) throw new Error(`Could not create run: ${error?.message}`);
      return data.id as string;
    },
    async loadRun(runId) {
      const { data } = await admin
        .from("workflow_runs")
        .select("id, status, log")
        .eq("id", runId)
        .maybeSingle();
      if (!data) return null;
      return {
        id: data.id as string,
        status: data.status as RunStatus,
        // A row written before 0018 could hold the '[]' default, which has no
        // .journal at all — and drive() calls .map on it immediately.
        log: normalizeLog(data.log),
      };
    },
    async saveRun(runId, patch) {
      // The journal IS the exactly-once guarantee: if this write is lost, the
      // next drive replays a step whose side effect already happened. Swallowing
      // the error let the engine keep publishing against a row that was no
      // longer recording anything, so a lost write now stops the run.
      const { error } = await admin
        .from("workflow_runs")
        .update({
          log: patch.log,
          // Heartbeat. Every journal write says "still alive", so the drain
          // only steals a run that has genuinely stopped moving, and the
          // reclaim only settles one nothing is driving.
          claimed_at: new Date().toISOString(),
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.finished ? { finished_at: new Date().toISOString() } : {}),
        })
        .eq("id", runId);
      if (error) throw new Error(`Could not persist run ${runId}: ${error.message}`);
    },
  };
}

/** In-memory engine persistence for demo mode (no Supabase). */
export function memoryRunStore(): RunStore & { runs: Map<string, { status: RunStatus; log: RunLog }> } {
  const runs = new Map<string, { status: RunStatus; log: RunLog }>();
  return {
    runs,
    async createRun(_workflowId, log) {
      const id = randomUUID();
      runs.set(id, { status: "running", log });
      return id;
    },
    async loadRun(runId) {
      const r = runs.get(runId);
      return r ? { id: runId, status: r.status, log: r.log } : null;
    },
    async saveRun(runId, patch) {
      const r = runs.get(runId);
      if (!r) return;
      r.log = patch.log;
      if (patch.status) r.status = patch.status;
    },
  };
}

/**
 * Coerce whatever is in `workflow_runs.log` into the shape the engine expects.
 *
 * The column defaulted to '[]' — an array — where every reader wants an object
 * with `.journal`. 0018 fixes the default and rewrites the offending rows, but
 * this stays: a log is the run's own memory and reading it must never throw.
 */
export function normalizeLog(raw: unknown): RunLog {
  const log = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Partial<RunLog>;
  return {
    ...log,
    v: 1,
    journal: Array.isArray(log.journal) ? log.journal : [],
    context: log.context ?? { steps: {} },
  } as RunLog;
}

/** Statuses that mean "this run has not landed anywhere yet". */
export const OPEN_STATUSES: RunStatus[] = ["queued", "running", "waiting"];

/**
 * Recompute a workflow's aggregate stats from its runs.
 *
 * The success rate used to be completed / (completed + failed), so every
 * non-terminal run was missing from BOTH halves — a workflow that crashed on
 * every single run, leaving each one `running` forever, displayed 100%. Open
 * runs are now counted and reported separately, and a workflow with no
 * terminal runs at all has no rate rather than a flattering one.
 */
export async function updateWorkflowStats(
  admin: DbClient,
  workflowId: string,
): Promise<void> {
  const { data } = await admin
    .from("workflow_runs")
    .select("status, started_at")
    .eq("workflow_id", workflowId);
  const rows = (data as { status: string; started_at: string }[]) ?? [];
  if (!rows.length) return;
  const completed = rows.filter((r) => r.status === "completed").length;
  const failed = rows.filter((r) => r.status === "failed").length;
  const terminal = completed + failed;
  const lastRun = rows.reduce(
    (max, r) => (r.started_at > max ? r.started_at : max),
    rows[0].started_at,
  );
  await admin
    .from("workflows")
    .update({
      runs: rows.length,
      // The rate stays a rate: completed out of the runs that actually LANDED
      // somewhere. Open runs are reported separately by the API (see
      // openRuns) rather than folded in here, because a number in a field
      // labelled "success" has to mean success.
      success_rate: terminal ? `${Math.round((100 * completed) / terminal)}%` : null,
      last_run_at: lastRun,
    })
    .eq("id", workflowId);
}
