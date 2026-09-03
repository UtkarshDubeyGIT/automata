import { strict as assert } from "node:assert";
import { test } from "node:test";
import { moveStepToEdge } from "@/lib/workflows/edit";
import { NODE_H, layoutGraph } from "@/lib/workflows/layout";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * The canvas derives every position from the graph on each render, so these are
 * the properties that keep the picture honest: one circle per step, lanes that
 * don't sit on top of each other, and a rejoining path drawn once.
 */

const LINEAR: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "draft" },
    draft: { type: "ai_step", instruction: "write", next: "post" },
    post: { type: "log_action", next: null },
  },
};

const BRANCHED: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "check" },
    check: {
      type: "branch",
      branch_on: "verdict",
      cases: { urgent: "escalate", routine: null },
      default: null,
    },
    escalate: { type: "log_action", next: null },
  },
};

/** Both paths of the approval land on the same step — a diamond. */
const DIAMOND: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "review" },
    review: { type: "human_approval", on_approve: "send", on_reject: "send" },
    send: { type: "log_action", next: null },
  },
};

test("every step is laid out exactly once, whatever the shape", () => {
  for (const graph of [LINEAR, BRANCHED, DIAMOND]) {
    const { nodes } = layoutGraph(graph);
    assert.deepEqual(
      nodes.map((n) => n.id).sort(),
      Object.keys(graph.steps).sort(),
    );
  }
});

test("a linear workflow is one row, running left to right", () => {
  const { nodes } = layoutGraph(LINEAR);
  const ys = new Set(nodes.map((n) => n.y));
  assert.equal(ys.size, 1, "every step shares one row");
  const xs = nodes.map((n) => n.x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, "columns advance along the spine");
});

test("a fan-out stacks its paths and centres the parent beside them", () => {
  const { nodes, ends } = layoutGraph(BRANCHED);
  const check = nodes.find((n) => n.id === "check")!;
  const escalate = nodes.find((n) => n.id === "escalate")!;

  assert.ok(escalate.x > check.x, "the path continues to the right of the step that forks");
  // Three paths leave `check`: the two named cases plus the default lane that
  // `edgeSlots` always adds to a branch.
  const lanes = [escalate, ...ends.filter((e) => e.x === escalate.x)].sort((a, b) => a.y - b.y);
  assert.equal(lanes.length, 3);
  for (let i = 1; i < lanes.length; i++) {
    assert.ok(lanes[i].y - lanes[i - 1].y >= NODE_H, "lanes don't overlap");
  }
  assert.ok(
    check.y > lanes[0].y && check.y < lanes[lanes.length - 1].y,
    "the branching step sits between the paths it opens",
  );
});

test("a path that rejoins is drawn as one node and a join edge", () => {
  const { nodes, edges } = layoutGraph(DIAMOND);
  assert.equal(nodes.filter((n) => n.id === "send").length, 1, "no duplicate of the shared step");
  const joins = edges.filter((e) => e.kind === "join");
  assert.equal(joins.length, 1);
  assert.deepEqual(
    { from: joins[0].from, to: joins[0].to, label: joins[0].label },
    { from: "review", to: "send", label: "Rejected" },
  );
});

test("open ends get a marker and an arrow that can be appended to", () => {
  const { ends, edges } = layoutGraph(LINEAR);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].root, true);
  const endEdge = edges.find((e) => e.kind === "end")!;
  assert.deepEqual({ from: endEdge.from, slot: endEdge.slot }, { from: "post", slot: "next" });
});

test("dragging a step onto a later arrow re-splices it there", () => {
  // trigger → draft → post, with `draft` dropped on the post → end arrow.
  const moved = moveStepToEdge(LINEAR, "draft", { from: "post", slot: "next" });
  assert.equal(moved.steps.trigger.next, "post");
  assert.equal(moved.steps.post.next, "draft");
  assert.equal(moved.steps.draft.next, null);
});

test("an illegal drag leaves the graph untouched, so the drop snaps back", () => {
  // The trigger can't move, a step can't hang off itself, a fan-out has no
  // single path to continue from, and the arrow it already sits on is a no-op.
  assert.equal(moveStepToEdge(LINEAR, "trigger", { from: "draft", slot: "next" }), LINEAR);
  assert.equal(moveStepToEdge(LINEAR, "draft", { from: "draft", slot: "next" }), LINEAR);
  assert.equal(moveStepToEdge(LINEAR, "draft", { from: "trigger", slot: "next" }), LINEAR);
  assert.equal(moveStepToEdge(BRANCHED, "check", { from: "escalate", slot: "next" }), BRANCHED);
});

test("a step can be dragged into a branch path", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { type: "manual_trigger_input", next: "note" },
      note: { type: "log_action", next: "check" },
      check: { type: "branch", branch_on: "verdict", cases: { urgent: null }, default: null },
    },
  };
  const moved = moveStepToEdge(graph, "note", { from: "check", slot: "case:urgent" });
  assert.equal(moved.steps.trigger.next, "check");
  assert.equal(moved.steps.check.cases?.urgent, "note");
  assert.equal(moved.steps.note.next, null);
});
