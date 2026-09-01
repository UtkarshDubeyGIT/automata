import assert from "node:assert/strict";
import test from "node:test";

import { applySafetyDefaults } from "@/lib/workflows/safety";
import type { WorkflowGraph } from "@/lib/workflows/types";

test("AI drafts insert approval before an external write when unattended writes were not requested", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { id: "trigger", type: "manual_trigger", name: "Run manually", next: "send" },
      send: { id: "send", type: "app_action", name: "Send Slack message", app: "slack", action: "SLACK_SEND_MESSAGE", next: null },
    },
  };

  const safe = applySafetyDefaults(graph, { allowUnattendedWrites: false });

  assert.equal(safe.steps.trigger.next, "approve_send");
  assert.deepEqual(safe.steps.approve_send, {
    id: "approve_send",
    type: "approval",
    name: "Approve Send Slack message",
    prompt: "Approve Send Slack message before it changes data in Slack?",
    onApprove: "send",
    onReject: null,
    next: null,
  });
});

test("explicit unattended-write intent preserves the authored route", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { id: "trigger", type: "manual_trigger", name: "Run manually", next: "send" },
      send: { id: "send", type: "app_action", name: "Send Slack message", app: "slack", action: "SLACK_SEND_MESSAGE", next: null },
    },
  };

  const safe = applySafetyDefaults(graph, { allowUnattendedWrites: true });
  assert.deepEqual(safe, graph);
});
