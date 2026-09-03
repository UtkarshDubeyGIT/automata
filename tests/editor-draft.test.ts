import assert from "node:assert/strict";
import test from "node:test";

import {
  arrangeGraph,
  connectSteps,
  diffWorkflowGraphs,
  draftIssues,
  removeStepDetached,
  upstreamVariables,
  validateDraftEnvelope,
} from "@/lib/workflows/editor";
import * as editorModule from "@/lib/workflows/editor";
import type { WorkflowGraph } from "@/lib/workflows/types";

const graph: WorkflowGraph = {
  start: "start",
  steps: {
    start: { type: "manual_trigger_input", title: "Run manually", fields: ["topic"], next: "read" },
    read: { type: "app_action", title: "Read deals", tool: "HUBSPOT_LIST_DEALS", next: "write" },
    write: { type: "ai_step", title: "Write digest", output: "text", instruction: "Summarize", next: null },
  },
};

test("drafts may contain disconnected steps while reporting executable issues", () => {
  const disconnected: WorkflowGraph = {
    ...graph,
    steps: { ...graph.steps, spare: { type: "log_action", title: "Spare", next: null } },
  };
  assert.deepEqual(draftIssues(disconnected).map((issue) => issue.code), ["disconnected"]);
});

test("connection retargeting is atomic and refuses cycles", () => {
  const retargeted = connectSteps(graph, { from: "start", slot: "next" }, "write");
  assert.equal(retargeted.steps.start.next, "write");
  assert.equal(connectSteps(retargeted, { from: "write", slot: "next" }, "start"), retargeted);
});

test("deleting a step removes incident edges without pruning disconnected modules", () => {
  const next = removeStepDetached(graph, "read");
  assert.equal(next.steps.start.next, null);
  assert.ok(next.steps.write);
  assert.equal(next.steps.read, undefined);
});

test("arrange returns deterministic finite positions for every module", () => {
  const first = arrangeGraph(graph);
  assert.deepEqual(first, arrangeGraph(graph));
  assert.deepEqual(Object.keys(first).sort(), Object.keys(graph.steps).sort());
});

test("arrange places a rejoin after the longest incoming branch", () => {
  const branched: WorkflowGraph = {
    start: "start",
    steps: {
      start: { type: "manual_trigger_input", title: "Start", next: "approval" },
      approval: { type: "human_approval", title: "Review", on_approve: "short", on_reject: "long_1", next: null },
      short: { type: "log_action", title: "Short path", next: "join" },
      long_1: { type: "log_action", title: "Long path one", next: "long_2" },
      long_2: { type: "log_action", title: "Long path two", next: "join" },
      join: { type: "log_action", title: "Joined", next: null },
    },
  };

  const positions = arrangeGraph(branched);
  assert.ok(positions.join.x > positions.long_2.x);
});

test("arrange keeps disconnected draft steps in a compact area below the workflow", () => {
  const withLooseSteps: WorkflowGraph = {
    ...graph,
    steps: {
      ...graph.steps,
      loose_a: { type: "log_action", title: "Loose A", next: null },
      loose_b: { type: "log_action", title: "Loose B", next: null },
    },
  };

  const positions = arrangeGraph(withLooseSteps);
  const connectedBottom = Math.max(positions.start.y, positions.read.y, positions.write.y);
  assert.ok(positions.loose_a.y > connectedBottom);
  assert.ok(positions.loose_b.y > connectedBottom);
  assert.equal(positions.loose_a.y, positions.loose_b.y);
  assert.ok(Math.abs(positions.loose_a.x - positions.loose_b.x) <= 260);
});

test("automatic layout preserves manual positions for configuration-only edits", () => {
  const helper = (editorModule as typeof editorModule & { positionsAfterGraphChange?: (before: WorkflowGraph, after: WorkflowGraph, current: ReturnType<typeof arrangeGraph>) => ReturnType<typeof arrangeGraph> }).positionsAfterGraphChange;
  assert.equal(typeof helper, "function", "positionsAfterGraphChange should exist");
  if (!helper) return;
  const manual = { start: { x: 40, y: 80 }, read: { x: 320, y: 240 }, write: { x: 620, y: 80 } };
  const renamed: WorkflowGraph = { ...graph, steps: { ...graph.steps, read: { ...graph.steps.read, title: "Read every deal" } } };
  assert.equal(helper(graph, renamed, manual), manual);
});

test("automatic layout rearranges the canvas after a routing change", () => {
  const helper = (editorModule as typeof editorModule & { positionsAfterGraphChange?: (before: WorkflowGraph, after: WorkflowGraph, current: ReturnType<typeof arrangeGraph>) => ReturnType<typeof arrangeGraph> }).positionsAfterGraphChange;
  assert.equal(typeof helper, "function", "positionsAfterGraphChange should exist");
  if (!helper) return;
  const manual = { start: { x: 40, y: 80 }, read: { x: 320, y: 240 }, write: { x: 620, y: 80 } };
  const rerouted = connectSteps(graph, { from: "start", slot: "next" }, "write");
  assert.deepEqual(helper(graph, rerouted, manual), arrangeGraph(rerouted));
});

test("legacy generated positions upgrade without overwriting manual layouts", () => {
  const helper = (editorModule as typeof editorModule & { initialCanvasPositions?: (graph: WorkflowGraph, saved: ReturnType<typeof arrangeGraph>) => ReturnType<typeof arrangeGraph> }).initialCanvasPositions;
  assert.equal(typeof helper, "function", "initialCanvasPositions should exist");
  if (!helper) return;
  const branched: WorkflowGraph = {
    start: "start",
    steps: {
      start: { type: "manual_trigger_input", title: "Start", next: "approval" },
      approval: { type: "human_approval", title: "Review", on_approve: "short", on_reject: "long_1", next: null },
      short: { type: "log_action", title: "Short", next: "join" },
      long_1: { type: "log_action", title: "Long one", next: "long_2" },
      long_2: { type: "log_action", title: "Long two", next: "join" },
      join: { type: "log_action", title: "Join", next: null },
    },
  };
  const legacy = {
    start: { x: 96, y: 120 }, approval: { x: 356, y: 120 },
    short: { x: 616, y: 270 }, long_1: { x: 616, y: 120 },
    join: { x: 876, y: 120 }, long_2: { x: 876, y: 270 },
  };
  assert.deepEqual(helper(branched, legacy), arrangeGraph(branched));
  const manual = { ...legacy, approval: { x: 400, y: 200 } };
  assert.equal(helper(branched, manual), manual);
});

test("variable choices include only reachable upstream outputs", () => {
  assert.deepEqual(upstreamVariables(graph, "write").map((item) => item.expression), [
    "{{steps.start.input.topic}}",
    "{{steps.read.result}}",
    "{{steps.read.url}}",
    "{{steps.read.record_id}}",
  ]);
});

test("publish diff reports structural changes without configuration values", () => {
  const diff = diffWorkflowGraphs(graph, removeStepDetached(graph, "read"));
  assert.deepEqual(diff.removed, ["Read deals"]);
  assert.deepEqual(diff.changed, ["Run manually"]);
  assert.deepEqual(diff.added, []);
});

test("draft envelopes bound graph size and reject non-finite positions", () => {
  assert.deepEqual(validateDraftEnvelope(graph, { start: { x: Number.POSITIVE_INFINITY, y: 0 } }), ["Canvas positions must be finite numbers."]);
  const large: WorkflowGraph = { start: "start", steps: {} };
  for (let index = 0; index < 101; index += 1) large.steps[`step_${index}`] = { type: index ? "log_action" : "manual_trigger_input", title: `Step ${index}`, next: null };
  assert.deepEqual(validateDraftEnvelope(large, {}), ["Automations support up to 100 steps."]);
});
