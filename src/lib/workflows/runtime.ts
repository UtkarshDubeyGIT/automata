import { createHash } from "crypto";
import { CREDIT_COST, grantCredits, isDuplicateKey, spendCredits } from "@/lib/credits";
import { errorMessage, resumeRun } from "./engine";
import { getTool } from "./registry";
import { repairRefs } from "./repair";
import { dbRunStore, normalizeLog, updateWorkflowStats } from "./store";
import type { RunLog, RunResult, RunStatus, WorkflowGraph } from "./types";
import { queueWorkflowReminder } from "@/lib/whatsapp/service";
import { pollFirecrawlJob } from "@/lib/integrations/firecrawl";

/**
 * Deep Workflow Execution Runtime.
 *
 * Encapsulates the entire workflow execution lifecycle behind one cohesive seam:
 *   - Idempotent trigger claiming and optimistic credit debits
 *   - Synchronous in-request driving (manual test runs) vs asynchronous queueing
 *   - Queue draining with deadline management and stale-claim recovery
 *   - Replaying step journals without duplicate external side effects
 *   - Resuming parked runs after async media generation renders land
 *   - Automatic failure compensation and clean refunds
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbClient = { from(table: string): any };

export const RUN_COST = CREDIT_COST.workflow_run;

/** Ledger keys. Derived from the run id for exactly-once idempotency. */
const chargeKey = (runId: string) => `workflow_run:${runId}`;
const refundKey = (runId: string) => `workflow_refund:${runId}`;

// ---------------------------------------------------------------------------
// Idempotency keys — one per trigger kind
// ---------------------------------------------------------------------------

/** A manual run keys off a nonce the UI mints per click. */
export const manualKey = (nonce: string) => `manual:${nonce}`;

/**
 * A schedule keys off the slot it was DUE for — never floor(now / 15min).
 */
export const scheduleKey = (slot: Date) => `schedule:${slot.toISOString()}`;

/**
 * An app event keys off the record id, making the poll cursor advisory rather than load-bearing.
 */
export const appEventKey = (recordId: string) => `event:${recordId}`;

/**
 * A webhook keys off the sender's delivery id or a hash of the body within a time window.
 */
export function webhookKey(deliveryId: string | null, rawBody: string, now = Date.now()): string {
  if (deliveryId) return `webhook:${deliveryId.slice(0, 200)}`;
  const bucket = Math.floor(now / (5 * 60_000));
  const digest = createHash("sha256").update(rawBody).digest("hex").slice(0, 32);
  return `webhook:${bucket}:${digest}`;
}

// ---------------------------------------------------------------------------
// Claiming & Submission
// ---------------------------------------------------------------------------

export interface ClaimOptions {
  admin: DbClient;
  workflowId: string;
  workspaceId: string;
  /** The stored graph. Repaired once and snapshotted onto the run row. */
  graph: WorkflowGraph;
  input?: Record<string, unknown>;
  idempotencyKey: string;
  /**
   * "execute" drives in-request (Test button).
   * "enqueue" leaves queued for background workers.
   */
  mode: "execute" | "enqueue";
}

export interface ClaimResult {
  runId: string;
  status: RunStatus;
  error?: string;
  /** True when an identical trigger had already claimed this run. */
  duplicate: boolean;
  /** Set when the run was settled before doing anything. */
  refused?: { reason: "insufficient_credits" | "charge_failed"; balance: number; cost: number };
}

export async function claimRun(opts: ClaimOptions): Promise<ClaimResult> {
  const { admin, workflowId, workspaceId, idempotencyKey } = opts;

  // Repair references ONCE here and store what we repaired.
  const graph = repairRefs(opts.graph).graph;
  const log: RunLog = {
    v: 1,
    journal: [],
    context: { steps: {}, input: opts.input ?? {} },
  };

  const { data, error } = await admin
    .from("workflow_runs")
    .insert({
      workflow_id: workflowId,
      status: "queued",
      idempotency_key: idempotencyKey,
      graph,
      log,
    })
    .select("id")
    .single();

  if (error || !data) {
    if (isDuplicateKey(error)) {
      const existing = await findByKey(admin, workflowId, idempotencyKey);
      if (existing) return { runId: existing.id, status: existing.status, duplicate: true };
    }
    throw new Error(`Could not start a run: ${error?.message ?? "the insert returned nothing"}`);
  }
  const runId = data.id as string;

  const charge = await spendCredits(
    workspaceId,
    RUN_COST,
    "workflow_run",
    workflowId,
    chargeKey(runId),
  );
  if (!charge.ok) {
    const insufficient = charge.outcome === "insufficient";
    const reason = insufficient
      ? `Not enough credits — a run costs ${RUN_COST} and the balance is ${charge.balance}.`
      : "The charge for this run could not be recorded, so it was not started.";
    await settle(admin, runId, "failed", reason);
    await updateWorkflowStats(admin, workflowId);
    return {
      runId,
      status: "failed",
      error: reason,
      duplicate: false,
      refused: {
        reason: insufficient ? "insufficient_credits" : "charge_failed",
        balance: charge.balance,
        cost: charge.cost,
      },
    };
  }

  if (opts.mode === "enqueue") {
    return { runId, status: "queued", duplicate: false };
  }

  const result = await driveRun(admin, {
    id: runId,
    workflowId,
    workspaceId,
    graph,
    log,
  });
  return { ...result, duplicate: false };
}

export interface ClaimedRun {
  id: string;
  workflowId: string;
  workspaceId: string;
  graph: WorkflowGraph;
  log: RunLog;
}

export const STALE_CLAIM_MS = 5 * 60_000;

export interface DrivableRun {
  id: string;
  workflowId: string;
  log: RunLog;
  graph: WorkflowGraph | null;
}

/**
 * Win exclusive right to drive a run via compare-and-swap.
 */
export async function claimForDriving(
  admin: DbClient,
  runId: string,
  now = new Date(),
  opts: { includeWaiting?: boolean } = {},
): Promise<DrivableRun | null> {
  const cutoff = new Date(now.getTime() - STALE_CLAIM_MS).toISOString();
  const states = opts.includeWaiting
    ? `status.eq.queued,status.eq.waiting,and(status.eq.running,claimed_at.lt.${cutoff}),` +
      `and(status.eq.running,claimed_at.is.null)`
    : `status.eq.queued,and(status.eq.running,claimed_at.lt.${cutoff}),` +
      `and(status.eq.running,claimed_at.is.null)`;
  const { data } = await admin
    .from("workflow_runs")
    .update({ status: "running", claimed_at: now.toISOString() })
    .eq("id", runId)
    .or(states)
    .select("id, log, graph, workflow_id")
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id as string,
    workflowId: data.workflow_id as string,
    log: normalizeLog(data.log),
    graph: (data.graph as WorkflowGraph | null) ?? null,
  };
}

/**
 * Drive an already-claimed, already-charged run to its next state.
 */
export async function driveRun(admin: DbClient, run: ClaimedRun): Promise<RunResult> {
  const log: RunLog = { ...run.log, attempts: (run.log.attempts ?? 0) + 1 };

  await admin
    .from("workflow_runs")
    .update({ status: "running", claimed_at: new Date().toISOString(), log })
    .eq("id", run.id);

  let result: RunResult;
  try {
    result = await resumeRun(dbRunStore(admin), run.graph, run.id, run.workspaceId);
  } catch (err) {
    const message = errorMessage(err);
    await settle(admin, run.id, "failed", message);
    result = { runId: run.id, status: "failed", error: message };
  }

  if (result.status === "failed") {
    await refundIfClean(admin, run.id, run.workspaceId, run.graph);
    await queueWorkflowReminder({
      workspaceId: run.workspaceId,
      workflowId: run.workflowId,
      runId: run.id,
      kind: "workflow_failure",
      idempotencyKey: `workflow-failure:${run.id}`,
      body: `A Automata workflow failed: ${result.error ?? "The run could not complete."}\n\nOpen the workflow run for details.`,
    }).catch((error) => console.error("[workflows] could not queue WhatsApp failure alert:", error));
  } else if (result.status === "waiting") {
    const { data: waiting } = await admin.from("workflow_runs").select("log").eq("id", run.id).maybeSingle();
    const waitingLog = (waiting?.log ?? {}) as RunLog;
    if (waitingLog.pending) {
      await queueWorkflowReminder({
        workspaceId: run.workspaceId,
        workflowId: run.workflowId,
        runId: run.id,
        stepId: waitingLog.pending.stepId,
        kind: "workflow_approval",
        idempotencyKey: `workflow-approval:${run.id}:${waitingLog.pending.stepId}`,
        body: `A Automata workflow is waiting for your approval: ${waitingLog.pending.prompt}\n\nOpen the workflow run to review it.`,
      }).catch((error) => console.error("[workflows] could not queue WhatsApp approval alert:", error));
    }
  }
  await updateWorkflowStats(admin, run.workflowId);
  return result;
}

/**
 * Drive a run the moment it is enqueued, instead of leaving it for the beat.
 *
 * A webhook delivery used to sit `queued` for up to fifteen minutes
 * (`zidane-cron.timer`), which for "meeting ended -> post to Slack" reads as
 * broken rather than slow. This is the same fast-start `workflows/build` and
 * `video/generate` already do behind their own 202s: cron stays the recovery
 * path, this only removes the wait in the happy case.
 *
 * Best-effort on purpose, and it never throws. `claimForDriving` is the very
 * compare-and-swap the beat uses, so losing the race is not an error, and a
 * kick killed mid-drive leaves a `running` row that `reclaimStuckRuns` takes
 * back after STALE_CLAIM_MS. Callers are `after(...)` continuations whose
 * response has already gone out, so there is nobody left to report to.
 */
export async function kickRun(
  admin: DbClient,
  runId: string,
  workspaceId: string,
): Promise<void> {
  try {
    const claimed = await claimForDriving(admin, runId);
    // No claim: the beat already has it, or it is no longer drivable.
    if (!claimed) return;
    // A run with no stored graph is settled and refunded by `drainRuns`; it is
    // not worth duplicating that here for a case `claimRun` cannot produce.
    if (!claimed.graph?.start) return;
    await driveRun(admin, {
      id: runId,
      workflowId: claimed.workflowId,
      workspaceId,
      graph: claimed.graph,
      log: claimed.log,
    });
  } catch (err) {
    console.error(`[workflows] fast start for run ${runId} failed, leaving it for the beat:`, err);
  }
}

// ---------------------------------------------------------------------------
// Queue Draining & Recovery
// ---------------------------------------------------------------------------

const QUEUED_HORIZON_MS = 60 * 60_000;
const RUNNING_HORIZON_MS = 60 * 60_000;
const WAITING_HORIZON_MS = 30 * 24 * 60 * 60_000;
const MAX_DRIVE_ATTEMPTS = 3;

export interface DrainResult {
  examined: number;
  driven: number;
  completed: number;
  failed: number;
  waiting: number;
  deferred: number;
}

export async function drainRuns(
  admin: DbClient,
  opts: { deadline: number; limit?: number; now?: Date } = { deadline: Date.now() + 30_000 },
): Promise<DrainResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 25;
  const result: DrainResult = {
    examined: 0,
    driven: 0,
    completed: 0,
    failed: 0,
    waiting: 0,
    deferred: 0,
  };

  const { data } = await admin
    .from("workflow_runs")
    .select("id, status, started_at, workflow_id")
    .in("status", ["queued", "running"])
    .order("started_at", { ascending: true })
    .limit(limit);
  const rows = (data as { id: string; workflow_id: string }[]) ?? [];
  if (!rows.length) return result;
  result.examined = rows.length;

  const workspaces = await workspaceIdsFor(admin, rows.map((r) => r.workflow_id));

  for (const row of rows) {
    if (Date.now() >= opts.deadline) {
      result.deferred++;
      continue;
    }
    const workspaceId = workspaces.get(row.workflow_id);
    if (!workspaceId) continue;

    const claimed = await claimForDriving(admin, row.id, now);
    if (!claimed) continue;

    const { log, graph } = claimed;
    if (!graph?.start) {
      await settle(admin, row.id, "failed", "This run has no stored graph and cannot be resumed.");
      await refundIfClean(admin, row.id, workspaceId);
      result.failed++;
      continue;
    }

    if ((log.attempts ?? 0) >= MAX_DRIVE_ATTEMPTS) {
      const message = `Gave up after ${log.attempts} attempts — the run never got past ${describeStop(log)}.`;
      await settle(admin, row.id, "failed", message);
      await refundIfClean(admin, row.id, workspaceId, graph);
      result.failed++;
      continue;
    }

    const run = await driveRun(admin, {
      id: row.id,
      workflowId: claimed.workflowId,
      workspaceId,
      graph,
      log,
    });
    result.driven++;
    if (run.status === "completed") result.completed++;
    else if (run.status === "failed") result.failed++;
    else if (run.status === "waiting") result.waiting++;
  }

  return result;
}

export interface ResumeResult {
  /** Parked runs examined. */
  parked: number;
  /** Of those, ones whose render had landed. */
  resumed: number;
  /** Still rendering — left exactly as they were. */
  rendering: number;
}

export async function resumeRenders(
  admin: DbClient,
  opts: { deadline: number; limit?: number; now?: Date } = { deadline: Date.now() + 30_000 },
): Promise<ResumeResult> {
  const now = opts.now ?? new Date();
  const out: ResumeResult = { parked: 0, resumed: 0, rendering: 0 };

  const { data } = await admin
    .from("workflow_runs")
    .select("id, log, workflow_id")
    .eq("status", "waiting")
    .order("started_at", { ascending: true })
    .limit(opts.limit ?? 25);

  const allRows = ((data as { id: string; log: unknown; workflow_id: string }[]) ?? [])
    .map((row) => ({ ...row, log: normalizeLog(row.log) }))
    .filter((row) => row.log.awaiting?.ref);
  const rows = allRows.filter((row) => row.log.awaiting?.kind === "video");
  const firecrawlRows = allRows.filter((row) => row.log.awaiting?.kind === "firecrawl");
  if (!allRows.length) return out;
  out.parked = allRows.length;

  // One query for every clip these runs are watching, rather than one per run.
  const refs = [...new Set(rows.map((row) => row.log.awaiting!.ref))];
  const { data: videos } = refs.length
    ? await admin.from("videos").select("job_id, status").in("job_id", refs)
    : { data: [] };
  const landed = new Map(
    ((videos as { job_id: string; status: string }[]) ?? []).map((v) => [v.job_id, v.status]),
  );

  const workspaces = await workspaceIdsFor(admin, rows.map((r) => r.workflow_id));

  for (const row of rows) {
    if (Date.now() >= opts.deadline) break;
    const status = landed.get(row.log.awaiting!.ref);

    if (status && status !== "completed" && status !== "failed") {
      out.rendering++;
      continue;
    }

    const workspaceId = workspaces.get(row.workflow_id);
    if (!workspaceId) continue;

    const claimed = await claimForDriving(admin, row.id, now, { includeWaiting: true });
    if (!claimed) continue;

    const { log, graph } = claimed;
    if (!graph?.start) {
      await settle(admin, row.id, "failed", "This run has no stored graph and cannot be resumed.");
      await refundIfClean(admin, row.id, workspaceId);
      continue;
    }

    await driveRun(admin, {
      id: row.id,
      workflowId: claimed.workflowId,
      workspaceId,
      graph,
      log,
    });
    out.resumed++;
  }

  // Firecrawl jobs live at the provider, not in a local media table. Polling
  // happens before claiming the run, so a still-running crawl consumes no
  // drive attempt and remains durably parked. A completed job is then claimed
  // and replayed through the same handler, which polls the existing job id and
  // journals its output; it never creates a second crawl.
  const firecrawlWorkspaces = await workspaceIdsFor(admin, firecrawlRows.map((r) => r.workflow_id));
  for (const row of firecrawlRows) {
    if (Date.now() >= opts.deadline) break;
    const workspaceId = firecrawlWorkspaces.get(row.workflow_id);
    const awaiting = row.log.awaiting;
    if (!workspaceId || !awaiting) continue;
    const graph = (await admin.from("workflow_runs").select("graph").eq("id", row.id).maybeSingle()).data?.graph;
    const operation = awaiting.operation ?? (graph?.steps?.[awaiting.stepId]?.operation as "crawl" | "agent" | undefined) ?? "crawl";
    let ready = false;
    try {
      const polled = await pollFirecrawlJob(operation, awaiting.ref, {
        workspaceId,
        timeoutMs: 90_000,
      });
      ready = polled.kind === "result";
    } catch {
      // The handler will write the normalized provider error to the run. Do
      // not leave a key error or an outage parked until the 30-day horizon.
      ready = true;
    }
    if (!ready) {
      out.rendering++;
      continue;
    }
    const claimed = await claimForDriving(admin, row.id, now, { includeWaiting: true });
    if (!claimed) continue;
    if (!claimed.graph?.start) {
      await settle(admin, row.id, "failed", "This run has no stored graph and cannot be resumed.");
      await refundIfClean(admin, row.id, workspaceId);
      continue;
    }
    await driveRun(admin, {
      id: row.id,
      workflowId: claimed.workflowId,
      workspaceId,
      graph: claimed.graph,
      log: claimed.log,
    });
    out.resumed++;
  }

  return out;
}

/** Clear name for callers that resume more than video renders. */
export const resumeAwaiting = resumeRenders;

export interface ReclaimResult {
  failed: number;
  refunded: number;
}

export async function reclaimStuckRuns(
  admin: DbClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<ReclaimResult> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  const out: ReclaimResult = { failed: 0, refunded: 0 };

  const { data } = await admin
    .from("workflow_runs")
    .select("id, status, started_at, claimed_at, workflow_id, log, graph")
    .in("status", ["queued", "running", "waiting"])
    .order("started_at", { ascending: true })
    .limit(limit);
  const rows = (data as {
    id: string;
    status: string;
    started_at: string;
    claimed_at: string | null;
    workflow_id: string;
    log: unknown;
    graph: Record<string, unknown> | null;
  }[]) ?? [];
  if (!rows.length) return out;

  const workspaces = await workspaceIdsFor(admin, rows.map((r) => r.workflow_id));

  for (const row of rows) {
    const workspaceId = workspaces.get(row.workflow_id);
    if (!workspaceId) continue;

    const startedMs = new Date(row.started_at).getTime();
    const heartbeatMs = row.claimed_at ? new Date(row.claimed_at).getTime() : startedMs;
    const age = now.getTime() - startedMs;
    const silence = now.getTime() - heartbeatMs;

    if (row.status === "queued" && age > QUEUED_HORIZON_MS) {
      await settle(
        admin,
        row.id,
        "failed",
        "No scheduler picked this run up in time, so it never started. The credits were returned.",
      );
      await refundUnconditionally(workspaceId, row.id);
      out.failed++;
      out.refunded++;
      continue;
    }

    if (row.status === "running" && silence > RUNNING_HORIZON_MS) {
      const log = normalizeLog(row.log);
      await settle(
        admin,
        row.id,
        "failed",
        `This run stopped responding after ${describeStop(log)} and was abandoned.`,
      );
      if (await refundIfClean(admin, row.id, workspaceId)) out.refunded++;
      out.failed++;
      continue;
    }

    if (row.status === "waiting" && age > WAITING_HORIZON_MS) {
      const why = normalizeLog(row.log).awaiting
        ? "This run waited 30 days on work that never finished, so it expired."
        : "Nobody reviewed this run in 30 days, so it expired.";
      await settle(admin, row.id, "failed", why);
      if (await refundIfClean(admin, row.id, workspaceId)) out.refunded++;
      out.failed++;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Refunds & Side Effects
// ---------------------------------------------------------------------------

export function hadRealSideEffect(log: RunLog, graph?: WorkflowGraph): boolean {
  for (const entry of log.journal ?? []) {
    if (entry.type !== "social_post" && entry.type !== "app_action" && entry.type !== "whatsapp_reminder") continue;
    const output = (entry.output ?? {}) as Record<string, unknown>;
    if (output.sim === true || output.simulated === true) continue;
    if (output.successful !== true) continue;
    if (entry.type === "app_action") {
      const step = graph?.steps?.[entry.stepId];
      const tool = String(step?.tool ?? "");
      if (getTool(tool, step?.tool_spec)?.kind === "read") continue;
    }
    return true;
  }
  return false;
}

export async function refundIfClean(
  admin: DbClient,
  runId: string,
  workspaceId: string,
  fallbackGraph?: WorkflowGraph,
): Promise<boolean> {
  const { data } = await admin
    .from("workflow_runs")
    .select("log, graph")
    .eq("id", runId)
    .maybeSingle();
  const log = normalizeLog(data?.log);
  const graph = (data?.graph as WorkflowGraph | null) ?? fallbackGraph;
  if (hadRealSideEffect(log, graph)) return false;
  await grantCredits(workspaceId, RUN_COST, "refund", runId, refundKey(runId));
  return true;
}

export async function refundUnconditionally(
  workspaceId: string,
  runId: string,
): Promise<void> {
  await grantCredits(workspaceId, RUN_COST, "refund", runId, refundKey(runId));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function findByKey(
  admin: DbClient,
  workflowId: string,
  idempotencyKey: string,
): Promise<{ id: string; status: RunStatus } | null> {
  const { data } = await admin
    .from("workflow_runs")
    .select("id, status")
    .eq("workflow_id", workflowId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  return data ? { id: data.id as string, status: data.status as RunStatus } : null;
}

export async function settle(
  admin: DbClient,
  runId: string,
  status: Extract<RunStatus, "failed" | "completed">,
  message: string,
  stepId?: string,
): Promise<void> {
  const { data } = await admin
    .from("workflow_runs")
    .select("log")
    .eq("id", runId)
    .maybeSingle();
  const log = normalizeLog(data?.log);
  log.error = String(message).slice(0, 2000);
  if (stepId) log.failed = { stepId, message: log.error };
  const { error } = await admin
    .from("workflow_runs")
    .update({ status, log, finished_at: new Date().toISOString() })
    .eq("id", runId);
  if (error) throw new Error(`Could not settle run ${runId}: ${error.message}`);
}

async function workspaceIdsFor(
  admin: DbClient,
  workflowIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(workflowIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data } = await admin
    .from("workflows")
    .select("id, workspace_id")
    .in("id", unique);
  return new Map(
    ((data as { id: string; workspace_id: string }[]) ?? []).map((w) => [w.id, w.workspace_id]),
  );
}

function describeStop(log: RunLog): string {
  const journal = log.journal ?? [];
  const last = journal[journal.length - 1];
  if (!last) return "its first step";
  return `“${last.title}” (step ${journal.length})`;
}
