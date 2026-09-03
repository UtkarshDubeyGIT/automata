import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Await, resumeRun, startRun, type RunStore } from "@/lib/workflows/engine";
import { HANDLERS } from "@/lib/workflows/steps";
import { buildApprovalPreview } from "@/lib/workflows/preview";
import type { RunLog, RunStatus, StepType, WorkflowGraph } from "@/lib/workflows/types";

/**
 * Parking a run on a machine, and the difference between that and parking it
 * on a person.
 *
 * Both stop a run in the same durable way, and the temptation is to treat them
 * as one state. They are not: an approval is a decision only the user can
 * make, and a render is work that finishes on its own. Merging them puts "one
 * thing is waiting on you" in front of somebody whose only correct action is
 * to wait — which is the same failure, in the opposite direction, as an
 * approval that shows no content.
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

const graph: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "film" },
    film: { type: "generate_video", prompt: "the product", next: "post" },
    post: { type: "log_action", label: "publish", message: "{{steps.film.url}}", next: null },
  },
};

test("a step that parks on a render leaves the run waiting, unjournaled", async () => {
  const store = fakeStore();
  await withHandler(
    "generate_video",
    async () => {
      throw new Await("video", "vid_1", "Rendering a 10s video.");
    },
    async () => {
      const res = await startRun(store, { workflowId: "wf", graph, entityId: "ws-1" });
      assert.equal(res.status, "waiting");
      const run = store.runs.get(res.runId)!;
      assert.equal(run.log.awaiting?.ref, "vid_1");
      assert.equal(run.log.awaiting?.stepId, "film");
      // Nobody is being asked anything — this is the field the UI keys off to
      // keep a render out of "Needs your attention".
      assert.equal(run.log.pending, undefined);
      // An unfinished step must not be journaled, or replay would skip it.
      assert.equal(
        run.log.journal.some((j) => j.stepId === "film"),
        false,
      );
    },
  );
});

test("the parked step gets its wait back, and no other step does", async () => {
  const store = fakeStore();
  const seen: (string | undefined)[] = [];
  await withHandler(
    "generate_video",
    async (ctx) => {
      seen.push(ctx.awaiting?.ref);
      if (!ctx.awaiting) throw new Await("video", "vid_9", "Rendering.");
      return { url: "https://cdn.example.com/clip.mp4" };
    },
    async () => {
      const first = await startRun(store, { workflowId: "wf", graph, entityId: "ws-1" });
      const second = await resumeRun(store, graph, first.runId, "ws-1");
      assert.equal(second.status, "completed");
      // First execution saw nothing; the resumed one saw the clip it queued.
      assert.deepEqual(seen, [undefined, "vid_9"]);
    },
  );
});

test("finishing the step clears the wait, so the run stops looking parked", async () => {
  const store = fakeStore();
  let parkedOnce = false;
  await withHandler(
    "generate_video",
    async (ctx) => {
      if (!ctx.awaiting && !parkedOnce) {
        parkedOnce = true;
        throw new Await("video", "vid_2", "Rendering.");
      }
      return { url: "https://cdn.example.com/clip.mp4" };
    },
    async () => {
      const first = await startRun(store, { workflowId: "wf", graph, entityId: "ws-1" });
      const run = store.runs.get(first.runId)!;
      assert.ok(run.log.awaiting);

      const done = await resumeRun(store, graph, first.runId, "ws-1");
      assert.equal(done.status, "completed");
      assert.equal(store.runs.get(first.runId)!.log.awaiting, undefined);
      // The URL reached the step after it, which is the only reason any of
      // this exists.
      const published = store.runs.get(first.runId)!.log.journal.find((j) => j.stepId === "post");
      assert.equal(published?.output.message, "https://cdn.example.com/clip.mp4");
    },
  );
});

test("re-parking keeps the original start time, so the give-up horizon means something", async () => {
  const store = fakeStore();
  await withHandler(
    "generate_video",
    async () => {
      throw new Await("video", "vid_3", "Rendering.");
    },
    async () => {
      const first = await startRun(store, { workflowId: "wf", graph, entityId: "ws-1" });
      const since = store.runs.get(first.runId)!.log.awaiting!.since;
      await new Promise((r) => setTimeout(r, 5));
      await resumeRun(store, graph, first.runId, "ws-1");
      assert.equal(
        store.runs.get(first.runId)!.log.awaiting!.since,
        since,
        "a wait that restarts its own clock on every beat can never time out",
      );
    },
  );
});

// ---------------------------------------------------------------------------
// What the approval card says about a clip
// ---------------------------------------------------------------------------

const approvalGraph: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "film" },
    film: { type: "generate_video", prompt: "the product", next: "review" },
    review: { type: "human_approval", prompt: "Post it?", on_approve: "post", on_reject: null },
    post: {
      type: "social_post",
      platform: "instagram",
      text: "New clip",
      mediaUrl: "{{steps.film.url}}",
      next: null,
    },
  },
};

test("the approval preview offers the clip to watch, not a link to trust", async () => {
  const log = {
    v: 1 as const,
    journal: [
      {
        stepId: "film",
        type: "generate_video" as StepType,
        title: "Generate the video",
        status: "done" as const,
        output: { url: "https://cdn.example.com/clip.mp4", grounded: true, brand: "Experiments" },
        at: new Date().toISOString(),
      },
    ],
    context: { steps: { film: { url: "https://cdn.example.com/clip.mp4" } } },
  };
  const preview = buildApprovalPreview(approvalGraph, "review", log)!;
  const action = preview.actions[0];
  // An .mp4 in an <img> is a broken image, and a link saying "clip.mp4" is not
  // a preview of a video.
  assert.equal(action.videoUrl, "https://cdn.example.com/clip.mp4");
  assert.equal(action.imageUrl, undefined);
});

test("the card says who the clip was made for, and says when nobody", async () => {
  const entry = (grounded: boolean, brand?: string) => ({
    v: 1 as const,
    journal: [
      {
        stepId: "film",
        type: "generate_video" as StepType,
        title: "Generate the video",
        status: "done" as const,
        output: { url: "https://cdn.example.com/clip.mp4", grounded, ...(brand ? { brand } : {}) },
        at: new Date().toISOString(),
      },
    ],
    context: { steps: {} },
  });

  const good = buildApprovalPreview(approvalGraph, "review", entry(true, "Experiments"))!;
  assert.equal(good.grounding?.applied, true);
  assert.equal(good.grounding?.brand, "Experiments");
  assert.deepEqual(good.grounding?.kinds, ["video"]);

  // The case worth having: a run whose brand profile could not be read made
  // something generic, and nothing on screen used to say so.
  const generic = buildApprovalPreview(approvalGraph, "review", entry(false))!;
  assert.equal(generic.grounding?.applied, false);
});

test("a run journaled before grounding existed claims nothing either way", async () => {
  const log = {
    v: 1 as const,
    journal: [
      {
        stepId: "film",
        type: "generate_video" as StepType,
        title: "Generate the video",
        status: "done" as const,
        output: { url: "https://cdn.example.com/clip.mp4" },
        at: new Date().toISOString(),
      },
    ],
    context: { steps: {} },
  };
  // Absence of the flag is not evidence of a generic draft — saying "written
  // generically" about an older run would be inventing a fact.
  assert.equal(buildApprovalPreview(approvalGraph, "review", log)!.grounding, undefined);
});
