import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * SIMULATION TAINT.
 *
 * The dangerous combination is a preview AI draft — what we emit with no
 * OPENAI_API_KEY — reaching a LIVE Composio connection. That publishes
 * "[preview output for: …]" to somebody's real account and records the run as
 * completed and billed.
 *
 * The env has to be arranged BEFORE the modules load, because `env.ts` reads
 * process.env once at import. No provider is ever called: the refusal is
 * thrown before socialProvider.post, which is the point.
 */
process.env.COMPOSIO_API_KEY = "test-key-composio-is-live";
delete process.env.OPENAI_API_KEY;

// Type-only imports are erased, so they can't load a module before the env
// above is arranged.
import type { RunLog, RunStatus, WorkflowGraph } from "@/lib/workflows/types";
import type { RunStore } from "@/lib/workflows/engine";

const { startRun } = await import("@/lib/workflows/engine");
const { socialProvider } = await import("@/lib/social/composio");
const { hadRealSideEffect } = await import("@/lib/workflows/claim");

function fakeStore(): RunStore & { runs: Map<string, { status: RunStatus; log: RunLog }> } {
  const runs = new Map<string, { status: RunStatus; log: RunLog }>();
  let n = 0;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
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
}

test("the fixture really does look live to the post handler", () => {
  assert.equal(socialProvider.live, true);
});

/**
 * The graph the plan names: a sim ai_step reaching a live social_post THROUGH
 * a branch and a second ai_step. Taint has to survive both hops.
 */
const laundered = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "classify" },
    classify: {
      type: "ai_step",
      output: "json",
      instruction: "classify the input",
      schema: { sentiment: "positive or negative" },
      next: "pick",
    },
    pick: {
      type: "branch",
      from_step: "classify",
      key: "sentiment",
      branch_on: "sentiment",
      cases: { positive: "polish", negative: "polish" },
      default: "polish",
    },
    polish: { type: "ai_step", instruction: "write the post", next: "publish" },
    publish: { type: "social_post", platform: "linkedin", text: "{{steps.polish.text}}", next: null },
  },
} as WorkflowGraph;

test("a simulated draft is refused at a live publish, through a branch and a second AI step", async () => {
  const store = fakeStore();
  const result = await startRun(store, { workflowId: "wf", graph: laundered, entityId: "ws" });

  assert.equal(result.status, "failed");
  assert.match(String(result.error), /preview data/);
  // Named so the user can see WHERE the fake data came in.
  assert.match(String(result.error), /polish/);

  const log = store.runs.get(result.runId)!.log;
  assert.equal(log.failed?.stepId, "publish");
  // Nothing was published, so nothing is in the journal past the draft.
  assert.deepEqual(
    log.journal.map((j) => j.stepId),
    ["trigger", "classify", "pick", "polish"],
  );
});

test("taint is carried, transitively, on every intermediate step", async () => {
  const store = fakeStore();
  const result = await startRun(store, { workflowId: "wf", graph: laundered, entityId: "ws" });
  const byId = new Map(store.runs.get(result.runId)!.log.journal.map((j) => [j.stepId, j.output]));
  // The AI step marks itself; the branch and the second AI step inherit it.
  assert.equal(byId.get("classify")?.sim, true, "the sim ai_step");
  assert.equal(byId.get("pick")?.sim, true, "the branch it fed");
  assert.equal(byId.get("polish")?.sim, true, "the second ai_step downstream of it");
  // The trigger read nothing simulated, so it stays clean.
  assert.equal(byId.get("trigger")?.sim, undefined);
});

test("a post that references nothing simulated is not refused", async () => {
  const store = fakeStore();
  const staticPost = {
    start: "trigger",
    steps: {
      trigger: { type: "manual_trigger_input", next: "publish" },
      publish: { type: "social_post", platform: "linkedin", text: "A fixed announcement.", next: null },
    },
  } as WorkflowGraph;
  const result = await startRun(store, { workflowId: "wf", graph: staticPost, entityId: "ws" });
  // It fails at the provider (there is no real Composio behind the fake key),
  // but NOT with the taint refusal — nothing simulated crossed into it.
  assert.doesNotMatch(String(result.error ?? ""), /preview data/);
});

test("a run whose only side effects were simulated is refundable", () => {
  const simulatedPublish = {
    v: 1 as const,
    journal: [
      {
        stepId: "publish",
        type: "social_post" as const,
        title: "Post",
        status: "done" as const,
        output: { successful: true, simulated: true, sim: true },
        at: "2026-08-27T10:00:00.000Z",
      },
    ],
    context: { steps: {} },
  };
  assert.equal(hadRealSideEffect(simulatedPublish), false);

  const realPublish = {
    ...simulatedPublish,
    journal: [
      { ...simulatedPublish.journal[0], output: { successful: true, simulated: false } },
    ],
  };
  // A run that emailed the customer at step 3 and failed at step 4 used to be
  // refunded in full — the work happened and nobody paid for it.
  assert.equal(hadRealSideEffect(realPublish), true);
});

test("a successful READ is not a side effect", () => {
  const log = {
    v: 1 as const,
    journal: [
      {
        stepId: "fetch",
        type: "app_action" as const,
        title: "Fetch issues",
        status: "done" as const,
        output: { successful: true, tool: "GITHUB_LIST_REPOSITORY_ISSUES" },
        at: "2026-08-27T10:00:00.000Z",
      },
    ],
    context: { steps: {} },
  };
  const graph = {
    start: "fetch",
    steps: { fetch: { type: "app_action", tool: "GITHUB_LIST_REPOSITORY_ISSUES", next: null } },
  } as WorkflowGraph;
  assert.equal(hadRealSideEffect(log, graph), false);
});
