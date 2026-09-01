import assert from "node:assert/strict";
import test from "node:test";

import { validateGraph } from "@/lib/workflows/validate";
import type { WorkflowGraph } from "@/lib/workflows/types";

test("a workflow must begin with a trigger", () => {
  const graph: WorkflowGraph = {
    start: "send",
    steps: {
      send: { id: "send", type: "app_action", name: "Send", app: "slack", action: "SLACK_SEND_MESSAGE", next: null },
    },
  };
  assert.deepEqual(validateGraph(graph), ["The first step must be a trigger."]);
});

test("a workflow rejects cycles and missing destinations", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { id: "trigger", type: "manual_trigger", name: "Run", next: "filter" },
      filter: { id: "filter", type: "filter", name: "Filter", next: "trigger", onFalse: "missing" },
    },
  };
  assert.deepEqual(validateGraph(graph), [
    "Filter points to a step that does not exist: missing.",
    "Workflow contains a cycle.",
  ]);
});
