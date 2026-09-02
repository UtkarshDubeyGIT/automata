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
    start: { id: "start", type: "manual_trigger", name: "Run manually", next: "read", fields: ["topic"] },
    read: { id: "read", type: "app_action", name: "Read deals", operation: "read", outputs: ["deals", "count"], next: "write" },
    write: { id: "write", type: "ai", name: "Write digest", output: "text", next: null },
  },
};

test("drafts may contain disconnected steps while reporting executable issues", () => {
  const disconnected: WorkflowGraph = {
    ...graph,
    steps: { ...graph.steps, spare: { id: "spare", type: "log", name: "Spare", next: null } },
  };
  assert.deepEqual(draftIssues(disconnected).map((issue) => issue.code), ["disconnected"]);
});

test("connection retargeting is atomic and refuses cycles", () => {
  const retargeted = connectSteps(graph, { from: "start", slot: "next" }, "write");
  assert.equal(retargeted.steps.start.next, "write");
  assert.equal(connectSteps(retargeted, { from: "write", slot: "next" }, "start"), retargeted);
});

test("deleting a step removes incident edges without deleting disconnected modules", () => {
  const next = removeStepDetached(graph, "read");
  assert.equal(next.steps.start.next, null);
  assert.ok(next.steps.write);
  assert.equal(next.steps.read, undefined);
});

test("arrange returns deterministic finite positions for every module", () => {
  const first = arrangeGraph(graph);
  const second = arrangeGraph(graph);
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), Object.keys(graph.steps).sort());
  assert.ok(Object.values(first).every((position) => Number.isFinite(position.x) && Number.isFinite(position.y)));
});

test("arrange places a rejoin after the longest incoming branch", () => {
  const branched: WorkflowGraph = {
    start: "start",
    steps: {
      start: { id: "start", type: "manual_trigger", name: "Start", next: "approval" },
      approval: { id: "approval", type: "approval", name: "Review", onApprove: "short", onReject: "long-1", next: null },
      short: { id: "short", type: "log", name: "Short path", next: "join" },
      "long-1": { id: "long-1", type: "log", name: "Long path one", next: "long-2" },
      "long-2": { id: "long-2", type: "log", name: "Long path two", next: "join" },
      join: { id: "join", type: "log", name: "Joined", next: null },
    },
  };

  const positions = arrangeGraph(branched);
  assert.ok(positions.join.x > positions["long-2"].x);
});

test("arrange keeps disconnected draft modules in a compact area below the workflow", () => {
  const withLooseModules: WorkflowGraph = {
    ...graph,
    steps: {
      ...graph.steps,
      "loose-a": { id: "loose-a", type: "log", name: "Loose A", next: null },
      "loose-b": { id: "loose-b", type: "log", name: "Loose B", next: null },
    },
  };

  const positions = arrangeGraph(withLooseModules);
  const connectedBottom = Math.max(positions.start.y, positions.read.y, positions.write.y);
  assert.ok(positions["loose-a"].y > connectedBottom);
  assert.ok(positions["loose-b"].y > connectedBottom);
  assert.equal(positions["loose-a"].y, positions["loose-b"].y);
  assert.ok(Math.abs(positions["loose-a"].x - positions["loose-b"].x) <= 260);
});

test("automatic layout preserves manual positions for configuration-only edits", () => {
  const helper = (editorModule as typeof editorModule & { positionsAfterGraphChange?: (before: WorkflowGraph, after: WorkflowGraph, current: ReturnType<typeof arrangeGraph>) => ReturnType<typeof arrangeGraph> }).positionsAfterGraphChange;
  assert.equal(typeof helper, "function", "positionsAfterGraphChange should exist");
  if (!helper) return;
  const manual = { start: { x: 40, y: 80 }, read: { x: 320, y: 240 }, write: { x: 620, y: 80 } };
  const renamed: WorkflowGraph = { ...graph, steps: { ...graph.steps, read: { ...graph.steps.read, name: "Read every deal" } } };
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
      start: { id: "start", type: "manual_trigger", name: "Start", next: "approval" },
      approval: { id: "approval", type: "approval", name: "Review", onApprove: "short", onReject: "long-1", next: null },
      short: { id: "short", type: "log", name: "Short", next: "join" },
      "long-1": { id: "long-1", type: "log", name: "Long one", next: "long-2" },
      "long-2": { id: "long-2", type: "log", name: "Long two", next: "join" },
      join: { id: "join", type: "log", name: "Join", next: null },
    },
  };
  const legacy = {
    start: { x: 96, y: 120 }, approval: { x: 356, y: 120 },
    short: { x: 616, y: 270 }, "long-1": { x: 616, y: 120 },
    join: { x: 876, y: 120 }, "long-2": { x: 876, y: 270 },
  };
  assert.deepEqual(helper(branched, legacy), arrangeGraph(branched));
  const manual = { ...legacy, approval: { x: 400, y: 200 } };
  assert.equal(helper(branched, manual), manual);
});

test("variable choices include only reachable upstream outputs", () => {
  assert.deepEqual(upstreamVariables(graph, "write").map((item) => item.expression), [
    "{{steps.start.input.topic}}",
    "{{steps.read.deals}}",
    "{{steps.read.count}}",
  ]);
});

test("publish diff reports structural changes without configuration values", () => {
  const changed = removeStepDetached(graph, "read");
  const diff = diffWorkflowGraphs(graph, changed);
  assert.deepEqual(diff.removed, ["Read deals"]);
  assert.deepEqual(diff.changed, ["Run manually"]);
  assert.deepEqual(diff.added, []);
});

test("draft envelopes bound graph size and reject non-finite positions", () => {
  assert.deepEqual(validateDraftEnvelope(graph, { start: { x: Number.NaN, y: 0 } }), ["Canvas positions must be finite numbers."]);
  const large: WorkflowGraph = { start: "start", steps: {} };
  for (let index = 0; index < 101; index += 1) large.steps[`step-${index}`] = { id: `step-${index}`, type: index ? "log" : "manual_trigger", name: `Step ${index}`, next: null };
  assert.deepEqual(validateDraftEnvelope(large, {}), ["Workflows support up to 100 modules."]);
});
