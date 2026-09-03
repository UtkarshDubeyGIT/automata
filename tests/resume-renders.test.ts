import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Waking a run that was parked on a render.
 *
 * This is the half of the video step that nothing else can cover: the step
 * knows how to park itself, but a parked run is `waiting`, and `drainRuns`
 * deliberately never touches a waiting run because that is somebody's pending
 * decision. Without this pass a clip would render perfectly, cost real money,
 * and then sit unpublished until the 30-day expiry swept the run away.
 *
 * The two properties that matter are opposites of each other: a landed clip
 * must be picked up, and a clip still rendering must be left completely alone
 * — no claim, no drive, no attempt counted against the run's retry budget.
 */

const db = new FakeDb();

mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => db,
    createClient: async () => db,
  },
});

const { resumeRenders } = await import("@/lib/workflows/drain");

const WORKSPACE = "ws-1";
const WORKFLOW = "wf-1";

/** Trigger → video (already journaled as done) → publish. */
const graph: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "film" },
    film: { type: "generate_video", prompt: "the product", next: "post" },
    post: { type: "log_action", label: "publish", message: "{{steps.film.url}}", next: null },
  },
};

function seedParkedRun(runId: string, jobId: string, videoStatus: string | null) {
  db.seed("workflow_runs", {
    id: runId,
    workflow_id: WORKFLOW,
    workspace_id: WORKSPACE,
    status: "waiting",
    started_at: new Date(Date.now() - 60_000).toISOString(),
    claimed_at: null,
    graph,
    idempotency_key: `manual:${runId}`,
    log: {
      v: 1,
      journal: [
        {
          stepId: "trigger",
          type: "manual_trigger_input",
          title: "Start",
          status: "done",
          output: {},
          at: new Date().toISOString(),
        },
      ],
      context: { steps: { trigger: {} } },
      awaiting: {
        kind: "video",
        stepId: "film",
        ref: jobId,
        note: "Rendering a 10s video.",
        since: new Date(Date.now() - 60_000).toISOString(),
      },
    },
  });
  if (videoStatus) {
    db.seed("videos", {
      id: `row-${jobId}`,
      workspace_id: WORKSPACE,
      job_id: jobId,
      status: videoStatus,
      url: videoStatus === "completed" ? "https://cdn.example.com/clip.mp4" : null,
    });
  }
}

function reset() {
  db.replace("workflow_runs", []);
  db.replace("videos", []);
  db.replace("credit_ledger", []);
  db.replace("workflows", []);
  db.seed("workflows", {
    id: WORKFLOW,
    workspace_id: WORKSPACE,
    active: true,
    config: { v: 1, graph, display: { groups: [] } },
  });
  db.seed("credit_ledger", { workspace_id: WORKSPACE, delta: 100, reason: "signup_bonus" });
}

test("a clip still rendering is left exactly as it was", async () => {
  reset();
  seedParkedRun("run-rendering", "vid_1", "processing");

  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  assert.equal(out.parked, 1);
  assert.equal(out.rendering, 1);
  assert.equal(out.resumed, 0);

  const row = db.table("workflow_runs")[0];
  // Untouched: still waiting, never claimed. A pass that claimed here would
  // burn one of the run's three drive attempts on every beat of a
  // fifteen-minute render, and give up before the clip ever landed.
  assert.equal(row.status, "waiting");
  assert.equal(row.claimed_at, null);
});

test("a clip that landed wakes the run and lets it finish", async () => {
  reset();
  seedParkedRun("run-landed", "vid_2", "completed");

  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  assert.equal(out.resumed, 1);

  const row = db.table("workflow_runs")[0];
  assert.notEqual(row.status, "waiting", "the run must not still be parked");
});

test("an approval waiting on a person is never driven by this pass", async () => {
  reset();
  db.seed("workflow_runs", {
    id: "run-approval",
    workflow_id: WORKFLOW,
    workspace_id: WORKSPACE,
    status: "waiting",
    started_at: new Date().toISOString(),
    claimed_at: null,
    graph,
    idempotency_key: "manual:run-approval",
    log: {
      v: 1,
      journal: [],
      context: { steps: {} },
      pending: { token: "t", stepId: "review", prompt: "Post it?" },
    },
  });

  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  // Not even counted: deciding somebody's approval for them is the one thing
  // this pass must never do.
  assert.equal(out.parked, 0);
  assert.equal(out.resumed, 0);
  assert.equal(db.table("workflow_runs")[0].status, "waiting");
});

test("a run watching a row that no longer exists is resumed to fail, not left forever", async () => {
  reset();
  seedParkedRun("run-orphan", "vid_gone", null);

  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  // Only the step itself can say what went wrong, so it is woken to say it
  // rather than expiring silently four weeks later.
  assert.equal(out.rendering, 0);
  assert.equal(out.resumed, 1);
  assert.notEqual(db.table("workflow_runs")[0].status, "waiting");
});
