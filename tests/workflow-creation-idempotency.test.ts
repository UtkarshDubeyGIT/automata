import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { insertWorkflow } from "@/lib/workflows/store";
import type { WorkflowConfig } from "@/lib/workflows/types";
import { FakeDb } from "./helpers/fake-supabase";

const routeDb = new FakeDb();
mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => ({
      supabase: routeDb,
      workspaceId: "workspace-route",
      userId: "user-1",
      entityId: "user-1",
    }),
  },
});
const { POST } = await import("@/app/api/workflows/route");

const config: WorkflowConfig = {
  v: 1,
  graph: { start: "start", steps: { start: { type: "manual_trigger_input", next: null } } },
  display: { groups: [] },
};
const fields = {
  workspaceId: "workspace-1",
  name: "A durable create",
  description: "One intended creation",
  active: false,
  schedule: "Manual",
  config,
  creationKey: "create-attempt-1",
};

test("the same workflow creation key returns the row already created", async () => {
  const db = new FakeDb();
  const first = await insertWorkflow(db, fields);
  const retry = await insertWorkflow(db, fields);
  assert.ok(first);
  assert.ok(retry);
  assert.equal(retry.id, first.id);
  assert.equal(db.table("workflows").length, 1);
});

test("different workflow creation keys can create separate rows", async () => {
  const db = new FakeDb();
  const first = await insertWorkflow(db, fields);
  const second = await insertWorkflow(db, { ...fields, creationKey: "create-attempt-2" });
  assert.ok(first);
  assert.ok(second);
  assert.notEqual(second.id, first.id);
  assert.equal(db.table("workflows").length, 2);
});

test("workflow POST retries with the same nonce return the same workflow", async () => {
  routeDb.replace("workflows", []);
  const request = () => new Request("http://growthos.test/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json", "x-workflow-nonce": "route-attempt-1" },
    body: JSON.stringify({ template: "blank" }),
  });
  const first = await POST(request());
  const retry = await POST(request());
  const firstBody = (await first.json()) as { workflow?: { id: string } };
  const retryBody = (await retry.json()) as { workflow?: { id: string }; duplicate?: boolean };
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.ok(firstBody.workflow);
  assert.equal(retryBody.workflow?.id, firstBody.workflow.id);
  assert.equal(retryBody.duplicate, true);
  assert.equal(routeDb.table("workflows").length, 1);
});
