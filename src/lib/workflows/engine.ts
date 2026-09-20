import type {
  JournalEntry,
  RunContext,
  RunLog,
  RunResult,
  RunStatus,
  StepDef,
  StepType,
  WorkflowGraph,
} from "./types";
import { destinationOf } from "./destination";
import { Await, HANDLERS, normalizeValue, Suspend, type StepCtx } from "./steps";
import { buildApprovalPreview } from "./preview";

/**
 * Durable workflow engine — TypeScript port of relay_poc/engine.py.
 *
 * Single-cursor graph interpreter: start at `graph.start`, execute the step,
 * journal its output, merge it into the run context, route to the next step.
 * The journal (one entry per completed step, persisted after EVERY step) is
 * the source of truth: re-driving a run replays journaled steps without
 * re-executing their side effects — exactly-once semantics on retry/resume.
 *
 * Nothing here is AI-specific: AI steps are just one handler among many.
 */

export { Await, Suspend };

/** Persistence seam — Supabase in production, in-memory in demo mode. */
export interface RunStore {
  createRun(workflowId: string, log: RunLog): Promise<string>;
  loadRun(runId: string): Promise<{ id: string; status: RunStatus; log: RunLog } | null>;
  saveRun(
    runId: string,
    patch: { status?: RunStatus; log: RunLog; finished?: boolean },
  ): Promise<void>;
}

export interface StartOptions {
  workflowId: string;
  graph: WorkflowGraph;
  input?: Record<string, unknown>;
  /** Composio entity (= workspace id) used by app_action / social_post. */
  entityId: string;
}

const STEP_BUDGET = 50;
const MAX_OUTPUT_BYTES = 20_000;

export async function startRun(store: RunStore, opts: StartOptions): Promise<RunResult> {
  const log: RunLog = {
    v: 1,
    journal: [],
    context: { steps: {}, input: opts.input ?? {} },
  };
  const runId = await store.createRun(opts.workflowId, log);
  return drive(store, opts.graph, runId, opts.entityId);
}

/** Resume a waiting/interrupted run. Idempotent — replay-based. */
export async function resumeRun(
  store: RunStore,
  graph: WorkflowGraph,
  runId: string,
  entityId: string,
): Promise<RunResult> {
  return drive(store, graph, runId, entityId);
}

async function drive(
  store: RunStore,
  graph: WorkflowGraph,
  runId: string,
  entityId: string,
): Promise<RunResult> {
  const run = await store.loadRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  const log = run.log;
  const journaled = new Map(log.journal.map((j) => [j.stepId, j.output]));

  // REPLAY: fast-forward past already-completed steps by following the
  // recorded routing decisions. Side effects are never repeated. The seen
  // set guards against a journaled cycle spinning this loop forever.
  let cursor: string | null = graph.start;
  const replayed = new Set<string>();
  while (cursor !== null && journaled.has(cursor) && !replayed.has(cursor)) {
    replayed.add(cursor);
    const step: StepDef | undefined = graph.steps[cursor];
    if (!step) break;
    cursor = route(step, journaled.get(cursor)!);
  }

  let budget = STEP_BUDGET;
  while (cursor !== null) {
    const step: StepDef | undefined = graph.steps[cursor];
    if (!step) {
      return fail(store, runId, log, `Unknown step '${cursor}' in graph`);
    }
    if (budget-- <= 0) {
      return fail(store, runId, log, `Step budget exceeded (${STEP_BUDGET}) — possible loop`);
    }

    const handler = HANDLERS[step.type as StepType];
    if (!handler) {
      return fail(store, runId, log, `No handler for step type '${step.type}'`);
    }

    const ctx: StepCtx = {
      runId,
      stepId: cursor,
      step,
      data: log.context,
      entityId,
      reads: new Set<string>(),
      // Only the step that is actually parked gets its wait back. Handing it
      // to any other step would tell a fresh `generate_video` that a clip it
      // never queued is already rendering.
      awaiting: log.awaiting?.stepId === cursor ? log.awaiting : undefined,
      /**
       * Only the writing step is told where the words go, and only the engine
       * can tell it: the graph lives here and nowhere else a handler can see.
       * Computed per step rather than once per run because an approval or a
       * second draft can sit between this step and whatever publishes it.
       */
      destination: step.type === "ai_step" ? (destinationOf(graph, cursor) ?? undefined) : undefined,
    };

    // A journal entry is deliberately written only AFTER a handler succeeds:
    // writing it earlier would make a restart skip a side effect that never
    // landed. The UI still needs to show a slow handler, though, so persist a
    // separate ephemeral marker before entering it. A restart overwrites this
    // marker when it drives the next unjournaled step.
    log.active = activeStep(cursor, step);
    await store.saveRun(runId, { log });

    let output: Record<string, unknown>;
    try {
      output = await handler(ctx);
    } catch (err) {
      if (err instanceof Await) {
        /**
         * Parked on a machine, not a person.
         *
         * Same durable mechanism as an approval and deliberately a different
         * field: `drain.ts` resumes this one by itself, the runs list calls it
         * "Rendering", and "Needs your attention" leaves it alone — nobody has
         * anything to decide while a video renders. `since` is preserved
         * across re-parks so the step's own horizon measures the whole wait
         * rather than restarting on every beat.
         */
        delete log.active;
        log.awaiting = {
          kind: err.kind,
          stepId: cursor,
          ref: err.ref,
          ...(err.operation ? { operation: err.operation } : {}),
          note: err.note,
          since: log.awaiting?.stepId === cursor ? log.awaiting.since : new Date().toISOString(),
        };
        await store.saveRun(runId, { status: "waiting", log });
        return { runId, status: "waiting" };
      }
      if (err instanceof Suspend) {
        // Durable pause: persist and return; a later resume replays to here.
        //
        // The preview is captured HERE, with the graph this run is replaying
        // against and the context it stopped with, because that is the only
        // moment both are final — an edit saved while the run waits must not
        // change what the approval card says is up for approval. It is
        // best-effort by contract: a run must never fail over a preview it
        // could not describe.
        delete log.active;
        log.pending = { token: err.token, stepId: cursor, prompt: err.prompt };
        try {
          const preview = buildApprovalPreview(graph, cursor, log);
          if (preview) log.pending.preview = preview;
        } catch (previewErr) {
          console.error("[workflows] could not describe the pending approval:", previewErr);
        }
        await store.saveRun(runId, { status: "waiting", log });
        return { runId, status: "waiting" };
      }
      return fail(store, runId, log, errorMessage(err), cursor);
    }

    // SIMULATION TAINT (see steps.ts): a step is simulated if it says so, or if
    // anything it read was. Applied here because this is the only place that
    // sees both what the handler read and the accumulated context.
    if (!output.sim && [...ctx.reads].some((id) => log.context.steps[id]?.sim === true)) {
      output = { ...output, sim: true };
    }

    // Route on the FULL output, persist a clamped copy. Clamping first meant a
    // large ai_step lost its whole `result` object, so `branch_on` found
    // nothing and silently took `default` — a routing decision changed by the
    // size of a string.
    const stored = clampOutput(output);

    // Journal + context in ONE atomic row write (relay journals first, then
    // context — a single jsonb replacement is strictly stronger).
    log.journal.push(entry(cursor, step, stored));
    log.context.steps[cursor] = stored;
    log.context.last = stored;
    delete log.active;
    if (log.pending?.stepId === cursor) delete log.pending;
    if (log.awaiting?.stepId === cursor) delete log.awaiting;
    await store.saveRun(runId, { log });

    cursor = route(step, output);
  }

  delete log.active;
  await store.saveRun(runId, { status: "completed", log, finished: true });
  return { runId, status: "completed" };
}

/** Decide the next step id from the step's routing config + output. */
export function route(step: StepDef, output: Record<string, unknown>): string | null {
  // Guard: a filter that doesn't pass takes on_fail, or ends the run when the
  // author left that path empty (the common "skip this one" case).
  if (step.type === "filter") {
    return (output?.passed === true ? step.next : step.on_fail) ?? null;
  }
  // Approval branch. Keyed off the step TYPE, plus a genuinely wired approve /
  // reject edge on any other type. Mere key PRESENCE used to be enough, so a
  // step carrying `on_reject: null` alongside a real `next` routed to null and
  // ended the run — the `next` it plainly declares was never read.
  if (step.type === "human_approval" || step.on_approve != null || step.on_reject != null) {
    return (output?.decision === "approve" ? step.on_approve : step.on_reject) ?? null;
  }
  // Conditional branch. Cases are matched through the SAME normaliser `filter`
  // uses, so a model answering "Positive" hits the "positive" case instead of
  // falling through to `default`.
  if (step.branch_on) {
    const result = output?.result;
    const value =
      output?.[step.branch_on] ??
      (result && typeof result === "object"
        ? (result as Record<string, unknown>)[step.branch_on]
        : undefined);
    const cases = step.cases ?? {};
    if (value !== undefined && value !== null) {
      const wanted = normalizeValue(value);
      for (const [caseValue, target] of Object.entries(cases)) {
        if (normalizeValue(caseValue) === wanted) return target ?? null;
      }
    }
    return step.default ?? null;
  }
  // Linear.
  return step.next ?? null;
}

/**
 * Anything can be thrown in JavaScript, including a string. `(err as Error)
 * .message.slice(...)` threw a TypeError inside the failure handler itself,
 * which left the run `running` forever and unrefunded — the failure path was
 * the least robust code in the engine.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error && typeof err.message === "string") return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

async function fail(
  store: RunStore,
  runId: string,
  log: RunLog,
  message: string,
  stepId?: string,
): Promise<RunResult> {
  delete log.active;
  log.error = String(message).slice(0, 2000);
  // WHICH step stopped the run. A failing step is never journaled (it produced
  // no output), so without this nothing downstream — the canvas replay above
  // all — can say where the run actually died.
  if (stepId) log.failed = { stepId, message: log.error };
  await store.saveRun(runId, { status: "failed", log, finished: true });
  return { runId, status: "failed", error: log.error };
}

function activeStep(stepId: string, step: StepDef) {
  return {
    stepId,
    type: step.type as StepType,
    title: typeof step.title === "string" ? step.title : stepId,
    startedAt: new Date().toISOString(),
  };
}

function entry(stepId: string, step: StepDef, output: Record<string, unknown>): JournalEntry {
  return {
    stepId,
    type: step.type,
    title: typeof step.title === "string" ? step.title : stepId,
    status: "done",
    output,
    at: new Date().toISOString(),
  };
}

/**
 * Keep the jsonb row bounded WITHOUT changing the shape of the output.
 *
 * The old version rebuilt a flat object of scalars, so an oversized ai_step
 * lost its entire `result` — every schema key with it. Downstream references
 * and branches then read undefined from a step that had actually succeeded.
 * This keeps every key at every depth and only shortens leaf strings.
 */
const MAX_STRING_CHARS = 4_000;
const MAX_ARRAY_ITEMS = 100;

export function clampOutput(output: Record<string, unknown>): Record<string, unknown> {
  try {
    if (JSON.stringify(output).length <= MAX_OUTPUT_BYTES) return output;
  } catch {
    // Circular or otherwise unserializable — nothing to journal but the fact.
    return { truncated: true };
  }
  const clamped = clampValue(output) as Record<string, unknown>;
  return { ...clamped, truncated: true };
}

function clampValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (typeof value === "string") {
    return value.length > MAX_STRING_CHARS ? value.slice(0, MAX_STRING_CHARS) : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((v) => clampValue(v, depth + 1));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        clampValue(v, depth + 1),
      ]),
    );
  }
  return value;
}

export type { RunContext, RunLog, RunResult, RunStatus, WorkflowGraph };
