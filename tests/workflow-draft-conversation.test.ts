import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import { BuildError, validateGraph } from "@/lib/workflows/validate";
import type { BuildOutput } from "@/lib/workflows/builder";
import type { WorkflowConfig, WorkflowGraph } from "@/lib/workflows/types";

const db = new FakeDb();
const initialGraph: WorkflowGraph = {
  start: "start",
  steps: {
    start: { type: "manual_trigger_input", next: "review" },
    review: { type: "human_approval", prompt: "Approve the summary?", on_approve: "send", on_reject: null },
    send: { type: "log_action", message: "Send the summary", next: null },
  },
};
const revisedGraph: WorkflowGraph = {
  start: "start",
  steps: {
    start: { type: "manual_trigger_input", next: "send" },
    send: { type: "log_action", message: "Send the summary", next: null },
  },
};
const initialBuild: BuildOutput = {
  name: "Email summary",
  description: "Summarize email before sending it.",
  config: {
    v: 1,
    prompt: "Summarize my email and send it to Slack.",
    graph: initialGraph,
    display: { groups: [] },
  },
  response: [[{ t: "I'll prepare a summary for review." }]],
  groups: [],
  simulated: false,
  requiredApps: [],
  needsBrand: false,
};

mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => ({
      supabase: db,
      workspaceId: "workspace-1",
      userId: "user-1",
      entityId: "user-1",
    }),
  },
});
mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => db },
});
mock.module("@/lib/workflows/builder", {
  namedExports: {
    BuildError,
    validateGraph,
    buildWorkflow: async () => initialBuild,
    editWorkflow: async (
      current: { graph: WorkflowGraph; originalRequest?: string; conversation?: string },
      instruction: string,
    ) => {
      assert.equal(current.graph.steps.review.type, "human_approval");
      assert.equal(current.originalRequest, initialBuild.config.prompt);
      assert.match(current.conversation ?? "", /User: Summarize my email/);
      assert.equal(instruction, "Skip approval and send it automatically.");
      return {
        graph: revisedGraph,
        name: "Email summary",
        description: "Summarize email and send it automatically.",
        response: [[{ t: "I'll send it without approval." }]],
        groups: [],
        requiredApps: [],
        needsBrand: false,
      };
    },
  },
});

const { POST: editDraft } = await import("@/app/api/workflows/build/[id]/edit/route");
const { POST: saveWorkflow } = await import("@/app/api/workflows/route");

test("a follow-up updates the existing build and Save persists the revised graph", async () => {
  db.replace("workflow_builds", []);
  db.replace("workflows", []);
  db.seed("workflow_builds", {
    id: "build-1",
    workspace_id: "workspace-1",
    request_key: "request-1",
    prompt: initialBuild.config.prompt,
    status: "completed",
    result: initialBuild,
  });

  const edit = await editDraft(
    new Request("http://localhost/api/workflows/build/build-1/edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "Skip approval and send it automatically.",
        history: "User: Summarize my email and send it to Slack.",
      }),
    }),
    { params: Promise.resolve({ id: "build-1" }) },
  );
  assert.equal(edit.status, 200);
  const editBody = await edit.json();
  assert.equal(db.table("workflow_builds").length, 1);
  const updated = db.table("workflow_builds")[0].result as BuildOutput;
  assert.equal(updated.config.graph.steps.review, undefined);
  assert.equal(updated.config.graph.steps.start.next, "send");

  const save = await saveWorkflow(new Request("http://localhost/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workflow-nonce": "save-build-1" },
    body: JSON.stringify({ buildId: "build-1", expectedRevision: editBody.edit.updatedAt }),
  }));
  assert.equal(save.status, 200);
  const saved = db.table("workflows")[0].config as WorkflowConfig;
  assert.equal(saved.graph.steps.review, undefined);
  assert.equal(saved.graph.steps.start.next, "send");
});

test("saving rejects an invalid build ID", async () => {
  const response = await saveWorkflow(new Request("http://localhost/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ buildId: { id: "build-1" } }),
  }));

  assert.equal(response.status, 400);
});

test("saving rejects a draft revision older than the server preview", async () => {
  const response = await saveWorkflow(new Request("http://localhost/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workflow-nonce": "stale-build-1" },
    body: JSON.stringify({ buildId: "build-1", expectedRevision: "2020-01-01T00:00:00.000Z" }),
  }));

  assert.equal(response.status, 409);
});
