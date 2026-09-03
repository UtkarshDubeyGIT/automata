import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "@/lib/workflows/engine";
import { BuildError, validateGraph } from "@/lib/workflows/validate";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Approve/reject edges on a step that cannot produce a decision.
 *
 * `route()` takes the approval branch on any step carrying a wired
 * `on_approve`/`on_reject`, but only `human_approval` ever emits a `decision`.
 * Everywhere else the branch reads `undefined` and takes `on_reject` on every
 * run — silently: nothing suspends, so no run reaches `waiting` and neither the
 * sidebar badge nor the review banner ever appears. The human-in-the-loop the
 * author asked for simply never happens.
 *
 * The visual editor cannot build this (`insertOnEdge` writes those keys only
 * when the node spec's `routing` declares them), so the reachable source is a
 * model ignoring builder.ts rule 7 — which is why the guard lives in the one
 * gate the AI, the editor and templates all share.
 */

const withDraftRouting = (routing: Record<string, unknown>): WorkflowGraph => ({
  start: "trigger",
  steps: {
    trigger: { type: "schedule_trigger", cadence: "daily", next: "draft" },
    draft: { type: "ai_step", instruction: "Write a post", output: "text", ...routing },
    publish: { type: "log_action", message: "published" },
    drop: { type: "log_action", message: "dropped" },
  },
});

test("an ai_step wired with approve/reject is refused, naming the fix", () => {
  assert.throws(
    () => validateGraph(withDraftRouting({ on_approve: "publish", on_reject: "drop" })),
    // The message is re-fed to the model on a repair round, so it has to say
    // what to build instead, not just what is wrong.
    (err: unknown) =>
      err instanceof BuildError &&
      /human_approval/.test(err.message) &&
      /reject path/.test(err.message),
  );
});

test("a single wired approve edge is enough to be refused", () => {
  assert.throws(() => validateGraph(withDraftRouting({ on_approve: "publish" })), BuildError);
  assert.throws(() => validateGraph(withDraftRouting({ on_reject: "drop" })), BuildError);
});

/**
 * A leftover `on_approve: null` is inert for routing, and the canvas can only
 * null an edge — it has no way to delete the key. Failing on it would strand an
 * already-saved graph behind an error the UI it points at cannot clear.
 */
test("a nulled approval key is inert and still saveable", () => {
  const graph = withDraftRouting({ on_approve: null, on_reject: null, next: "publish" });
  validateGraph(graph);
  assert.equal(route(graph.steps.draft, { text: "a post" }), "publish");
});

test("a real human_approval step still routes both ways", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { type: "schedule_trigger", cadence: "daily", next: "review" },
      review: { type: "human_approval", prompt: "Send it?", on_approve: "publish", on_reject: null },
      publish: { type: "log_action", message: "published" },
    },
  };
  validateGraph(graph);
  assert.equal(route(graph.steps.review, { decision: "approve" }), "publish");
  assert.equal(route(graph.steps.review, { decision: "reject" }), null);
});
