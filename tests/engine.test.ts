import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resumeRun, startRun, type RunStore } from "@/lib/workflows/engine";
import { HANDLERS } from "@/lib/workflows/steps";
import type { RunLog, RunStatus, StepType, WorkflowGraph } from "@/lib/workflows/types";

/**
 * The engine against a fake store. Every load and save round-trips through
 * JSON, exactly as the jsonb column does, so a test can't pass by accident on
 * a shared object reference.
 */
function fakeStore() {
  const runs = new Map<string, { status: RunStatus; log: RunLog }>();
  let n = 0;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  const store: RunStore & { runs: typeof runs } = {
    runs,
    async createRun(_workflowId, log) {
      const id = `run-${++n}`;
      runs.set(id, { status: "running", log: clone(log) });
      return id;
    },
    async loadRun(runId) {
      const r = runs.get(runId);
      return r ? { id: runId, status: r.status, log: clone(r.log) } : null;
    },
    async saveRun(runId, patch) {
      const r = runs.get(runId);
      if (!r) throw new Error(`no such run ${runId}`);
      r.log = clone(patch.log);
      if (patch.status) r.status = patch.status;
    },
  };
  return store;
}

/** Swap one handler for the duration of a test, then put it back. */
async function withHandler(
  type: StepType,
  handler: (typeof HANDLERS)[StepType],
  body: () => Promise<void>,
) {
  const original = HANDLERS[type];
  HANDLERS[type] = handler;
  try {
    await body();
  } finally {
    HANDLERS[type] = original;
  }
}

const linear: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "one" },
    one: { type: "log_action", label: "first", message: "a", next: "two" },
    two: { type: "log_action", label: "second", message: "b", next: null },
  },
};

test("a run journals every step and completes", async () => {
  const store = fakeStore();
  const result = await startRun(store, { workflowId: "wf", graph: linear, entityId: "ws" });
  assert.equal(result.status, "completed");
  const log = store.runs.get(result.runId)!.log;
  assert.deepEqual(log.journal.map((j) => j.stepId), ["trigger", "one", "two"]);
});

test("the node being executed is persisted until it finishes", async () => {
  const store = fakeStore();
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executing = new Promise<void>((resolve) => { started = resolve; });

  await withHandler(
    "log_action",
    async () => {
      started();
      await gate;
      return { performed: "first" };
    },
    async () => {
      const run = startRun(store, { workflowId: "wf", graph: linear, entityId: "ws" });
      await executing;

      const current = store.runs.get("run-1")!.log.active;
      assert.equal(current?.stepId, "one");
      assert.equal(current?.type, "log_action");
      assert.equal(current?.title, "one");
      assert.ok(current?.startedAt);

      release();
      await run;
      assert.equal(store.runs.get("run-1")!.log.active, undefined);
    },
  );
});

test("replay skips journaled steps rather than re-running them", async () => {
  const store = fakeStore();
  let executions = 0;
  await withHandler(
    "log_action",
    async (ctx) => {
      executions++;
      return { performed: String(ctx.step.label), message: "x" };
    },
    async () => {
      const first = await startRun(store, { workflowId: "wf", graph: linear, entityId: "ws" });
      assert.equal(executions, 2);
      const before = store.runs.get(first.runId)!.log.journal.map((j) => j.at);

      // Driving the same run again must repeat NO side effect. This is the
      // whole exactly-once guarantee: the beat resumes runs freely because
      // replay costs only the steps that never finished.
      const again = await resumeRun(store, linear, first.runId, "ws");
      assert.equal(again.status, "completed");
      assert.equal(executions, 2, "a journaled step was executed twice");
      assert.deepEqual(store.runs.get(first.runId)!.log.journal.map((j) => j.at), before);
    },
  );
});

test("a thrown string fails cleanly and records which step stopped it", async () => {
  const store = fakeStore();
  await withHandler(
    "log_action",
    async () => {
      // Anything can be thrown in JavaScript. `(err as Error).message.slice()`
      // made the FAILURE HANDLER itself throw, leaving the run `running`
      // forever and unrefunded.
      throw "provider exploded";
    },
    async () => {
      const result = await startRun(store, { workflowId: "wf", graph: linear, entityId: "ws" });
      assert.equal(result.status, "failed");
      const log = store.runs.get(result.runId)!.log;
      assert.equal(log.error, "provider exploded");
      // The data the canvas's red `x` reads. A failing step is never
      // journaled, so nothing else can say where the run died.
      assert.deepEqual(log.failed, { stepId: "one", message: "provider exploded" });
      assert.equal(store.runs.get(result.runId)!.status, "failed");
    },
  );
});

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

const withApproval: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "review" },
    review: {
      type: "human_approval",
      prompt: "Publish this?",
      on_approve: "publish",
      on_reject: null,
    },
    publish: { type: "log_action", label: "publish", message: "sent", next: null },
  },
};

test("an approval step suspends, and resumes exactly once", async () => {
  const store = fakeStore();
  let published = 0;
  await withHandler(
    "log_action",
    async () => {
      published++;
      return { performed: "publish", message: "sent" };
    },
    async () => {
      const first = await startRun(store, {
        workflowId: "wf",
        graph: withApproval,
        entityId: "ws",
      });
      // It used to auto-approve and publish, while the UI promised a review.
      assert.equal(first.status, "waiting");
      assert.equal(published, 0);
      const run = store.runs.get(first.runId)!;
      assert.equal(run.log.pending?.stepId, "review");
      assert.equal(run.log.pending?.prompt, "Publish this?");

      // Record the decision the way the decision route does.
      run.log.context.decisions = {
        review: { decision: "approve", at: new Date().toISOString() },
      };

      const second = await resumeRun(store, withApproval, first.runId, "ws");
      assert.equal(second.status, "completed");
      assert.equal(published, 1);
      assert.equal(store.runs.get(first.runId)!.log.pending, undefined);

      // Resuming again publishes nothing more.
      await resumeRun(store, withApproval, first.runId, "ws");
      assert.equal(published, 1, "an approved run published twice");
    },
  );
});

test("a rejection ends the run without publishing", async () => {
  const store = fakeStore();
  let published = 0;
  await withHandler(
    "log_action",
    async () => {
      published++;
      return { performed: "publish", message: "sent" };
    },
    async () => {
      const first = await startRun(store, {
        workflowId: "wf",
        graph: withApproval,
        entityId: "ws",
      });
      const run = store.runs.get(first.runId)!;
      run.log.context.decisions = {
        review: { decision: "reject", at: new Date().toISOString() },
      };
      const second = await resumeRun(store, withApproval, first.runId, "ws");
      assert.equal(second.status, "completed");
      assert.equal(published, 0);
    },
  );
});
