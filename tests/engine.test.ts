import assert from "node:assert/strict";
import test from "node:test";

import { executeWorkflow, type ExecutionAdapter } from "../src/lib/workflows/engine";
import type { WorkflowGraph, WorkflowStep } from "../src/lib/workflows/types";

const graph: WorkflowGraph = {
  start: "manual",
  steps: {
    manual: { id: "manual", name: "Run once", type: "manual_trigger", next: "draft" },
    draft: { id: "draft", name: "Draft message", type: "ai", prompt: "Welcome {{trigger.customer.name}}", next: "approve" },
    approve: { id: "approve", name: "Approve message", type: "approval", prompt: "Send {{steps.draft.text}}?", onApprove: "send", onReject: null },
    send: { id: "send", name: "Send message", type: "app_action", app: "whatsapp", action: "send_message", operation: "write" },
  },
};

function adapter(events: Array<string>): ExecutionAdapter {
  return {
    async execute(step: WorkflowStep, input: unknown) {
      events.push(`execute:${step.id}`);
      if (step.type === "ai") return { outcome: "succeeded", output: { text: `Hello ${(input as { customer: { name: string } }).customer.name}` }, providerCredits: 2 };
      if (step.type === "app_action") return { outcome: "succeeded", output: { messageId: "wa_123" } };
      return { outcome: "succeeded", output: input };
    },
    async journal(event) { events.push(`journal:${event.stepId}:${event.state}`); },
  };
}

test("a real run executes modules, journals outcomes, and pauses before an approval", async () => {
  const events: string[] = [];
  const result = await executeWorkflow({ graph, triggerData: { customer: { name: "Ava" } }, adapter: adapter(events) });

  assert.equal(result.state, "waiting_approval");
  assert.equal(result.waiting?.stepId, "approve");
  assert.equal(result.waiting?.prompt, "Send Hello Ava?");
  assert.deepEqual(result.outputs.draft, { text: "Hello Ava" });
  assert.equal(result.creditsUsed, 2);
  assert.ok(!events.includes("execute:send"), "external action must not execute before approval");
  assert.ok(events.includes("journal:draft:succeeded"));
  assert.ok(events.includes("journal:approve:waiting"));
});

test("an approved run resumes at the external action and charges its successful module", async () => {
  const events: string[] = [];
  const result = await executeWorkflow({
    graph,
    triggerData: { customer: { name: "Ava" } },
    existingOutputs: { draft: { text: "Hello Ava" } },
    resume: { approvalStepId: "approve", decision: "approved" },
    adapter: adapter(events),
  });

  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.outputs.send, { messageId: "wa_123" });
  assert.equal(result.creditsUsed, 1);
  assert.ok(events.includes("execute:send"));
});

test("a rejected run exits successfully without executing the protected action", async () => {
  const events: string[] = [];
  const result = await executeWorkflow({
    graph,
    triggerData: { customer: { name: "Ava" } },
    resume: { approvalStepId: "approve", decision: "rejected" },
    adapter: adapter(events),
  });
  assert.equal(result.state, "succeeded");
  assert.ok(!events.includes("execute:send"));
  assert.equal(result.creditsUsed, 0);
});

test("module failures stop the run, are journaled, and consume no credits", async () => {
  const events: string[] = [];
  const result = await executeWorkflow({
    graph: { start: "manual", steps: { manual: graph.steps.manual, draft: { ...graph.steps.draft, next: null } } },
    triggerData: { customer: { name: "Ava" } },
    adapter: {
      async execute() { return { outcome: "failed", error: "Provider unavailable" }; },
      async journal(event) { events.push(`journal:${event.stepId}:${event.state}`); },
    },
  });
  assert.equal(result.state, "failed");
  assert.equal(result.error, "Provider unavailable");
  assert.equal(result.creditsUsed, 0);
  assert.ok(events.includes("journal:draft:failed"));
});
