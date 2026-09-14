import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * `receiveWorkflowWebhook` is the meet.doubtbuddy.com ingestion node: the
 * first hop of "Notetaker → AI summary → Vikunja tasks". `webhook-route.test.ts`
 * only reaches the two 404s before the handler even looks at the body. This
 * file drives every other branch: content-type/size/JSON guards, the
 * inactive-workflow sample capture, the replay window, credit refusal, and
 * the accept path (queued / duplicate), with `claimRun`/`kickRun` mocked so
 * only the receiver's own logic is under test — `claim.test.ts` already
 * covers `claimRun` itself in depth.
 */

const db = new FakeDb();
const claimCalls: Array<{ workflowId: string; idempotencyKey: string; input?: Record<string, unknown> }> = [];
const kickCalls: string[] = [];
let claimResult: {
  runId: string;
  status: "queued" | "completed" | "failed";
  duplicate: boolean;
  refused?: { reason: "insufficient_credits" | "charge_failed"; balance: number; cost: number };
  error?: string;
} = { runId: "run-1", status: "queued", duplicate: false };

mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => db },
});

// `after()` requires a live Next.js request scope, which a handler called
// directly (not through the framework's route dispatch) never has. Every
// other export is the real module — only `after` runs its callback inline.
const realNextServer = await import("next/server");
mock.module("next/server", {
  namedExports: { ...realNextServer, after: (fn: () => unknown) => fn() },
});

mock.module("@/lib/workflows/runtime", {
  namedExports: {
    claimRun: async (opts: { workflowId: string; idempotencyKey: string; input?: Record<string, unknown> }) => {
      claimCalls.push(opts);
      return claimResult;
    },
    kickRun: async (_admin: unknown, runId: string) => {
      kickCalls.push(runId);
    },
    webhookKey: (deliveryId: string | null, rawBody: string) => `webhook:${deliveryId ?? rawBody.length}`,
  },
});

const { receiveWorkflowWebhook } = await import("@/lib/workflows/webhook-receiver");

const GRAPH: WorkflowGraph = {
  start: "meeting_complete",
  steps: {
    meeting_complete: { type: "webhook_trigger", secret: "notetaker-secret", next: "extract_actions" },
    extract_actions: { type: "meeting_summary", extract_action_items: true, next: null },
  },
};

function reset(overrides: Partial<{ active: boolean; graph: WorkflowGraph; draftGraph: WorkflowGraph }> = {}) {
  db.replace("workflows", []);
  claimCalls.length = 0;
  kickCalls.length = 0;
  claimResult = { runId: "run-1", status: "queued", duplicate: false };
  db.seed("workflows", {
    id: "wf-1",
    workspace_id: "ws-1",
    active: overrides.active ?? true,
    config: { v: 1, graph: overrides.graph ?? GRAPH, display: { groups: [] } },
    draft_config: overrides.draftGraph ? { v: 1, graph: overrides.draftGraph, display: { groups: [] } } : null,
    trigger_state: null,
  });
}

function req(body: unknown, init: { headers?: Record<string, string>; rawBody?: string } = {}) {
  const raw = init.rawBody ?? (body === undefined ? "" : JSON.stringify(body));
  return new NextRequest("http://localhost:3000/hooks/wf-1.notetaker-secret", {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: raw,
  });
}

test("an unknown workflow id returns an opaque 404", async () => {
  reset();
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-missing", "notetaker-secret");
  assert.equal(res.status, 404);
  assert.equal(claimCalls.length, 0);
});

test("a graph whose start is not a webhook_trigger is an opaque 404", async () => {
  reset({ graph: { start: "x", steps: { x: { type: "log_action", next: null } } } });
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "notetaker-secret");
  assert.equal(res.status, 404);
});

test("a wrong shared secret is an opaque 404, not a 401 that confirms the endpoint exists", async () => {
  reset();
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "wrong-secret");
  assert.equal(res.status, 404);
  assert.equal(claimCalls.length, 0);
});

test("a non-JSON content type is rejected with 415 before the body is read", async () => {
  reset();
  const res = await receiveWorkflowWebhook(
    req({ meeting_id: "m-1" }, { headers: { "content-type": "text/plain" } }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res.status, 415);
  assert.equal(claimCalls.length, 0);
});

test("a body over 1MB is rejected with 413", async () => {
  reset();
  const oversized = "A".repeat(1024 * 1024 + 1);
  const res = await receiveWorkflowWebhook(
    req(undefined, { rawBody: JSON.stringify({ meeting_id: "m-1", transcript: oversized }) }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res.status, 413);
});

test("a JSON array body is rejected — the payload must be an object", async () => {
  reset();
  const res = await receiveWorkflowWebhook(
    req(undefined, { rawBody: "[1,2,3]" }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res.status, 400);
});

test("malformed JSON is rejected with 400", async () => {
  reset();
  const res = await receiveWorkflowWebhook(
    req(undefined, { rawBody: "{not json" }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res.status, 400);
});

test("an inactive workflow saves the delivery as a sample and never claims a run", async () => {
  reset({ active: false });
  const payload = { meeting_id: "m-1", title: "Product sync", transcript: "Alex will send the proposal." };
  const res = await receiveWorkflowWebhook(req(payload), "wf-1", "notetaker-secret");

  assert.equal(res.status, 202);
  const body = (await res.json()) as { status: string; sample: boolean; fields: string[] };
  assert.equal(body.status, "sample");
  assert.equal(body.sample, true);
  assert.ok(body.fields.includes("title"));
  assert.equal(claimCalls.length, 0, "a paused automation must not run");

  const row = db.table("workflows")[0];
  const sample = (row.trigger_state as { sample?: { payload: unknown } }).sample;
  assert.deepEqual(sample?.payload, payload);
});

test("a paused workflow checks the secret against the DRAFT graph, not the published one", async () => {
  reset({
    active: false,
    graph: GRAPH,
    draftGraph: {
      start: "meeting_complete",
      steps: { meeting_complete: { type: "webhook_trigger", secret: "new-draft-secret", next: null } },
    },
  });
  const rejectedOld = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "notetaker-secret");
  assert.equal(rejectedOld.status, 404, "the old published secret no longer matches the edited draft");

  const acceptedNew = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "new-draft-secret");
  assert.equal(acceptedNew.status, 202);
});

test("a delivery outside the replay window is rejected with 408, in both seconds and milliseconds form", async () => {
  reset();
  const staleSeconds = Math.floor((Date.now() - 10 * 60_000) / 1000);
  const res1 = await receiveWorkflowWebhook(
    req({ meeting_id: "m-1" }, { headers: { "x-webhook-timestamp": String(staleSeconds) } }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res1.status, 408);

  const staleMs = Date.now() - 10 * 60_000;
  const res2 = await receiveWorkflowWebhook(
    req({ meeting_id: "m-2" }, { headers: { "x-webhook-timestamp": String(staleMs) } }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res2.status, 408);
  assert.equal(claimCalls.length, 0);
});

test("a fresh timestamp within the replay window is accepted", async () => {
  reset();
  const fresh = Date.now();
  const res = await receiveWorkflowWebhook(
    req({ meeting_id: "m-1" }, { headers: { "x-webhook-timestamp": String(fresh) } }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(res.status, 202);
});

test("insufficient credits are reported as 402 and no run is kicked", async () => {
  reset();
  claimResult = {
    runId: "run-x",
    status: "failed",
    duplicate: false,
    refused: { reason: "insufficient_credits", balance: 0, cost: 2 },
  };
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "notetaker-secret");
  assert.equal(res.status, 402);
  assert.equal(kickCalls.length, 0);
});

test("any other claim refusal is reported as 502", async () => {
  reset();
  claimResult = {
    runId: "run-x",
    status: "failed",
    duplicate: false,
    refused: { reason: "charge_failed", balance: 0, cost: 2 },
    error: "ledger unavailable",
  };
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "notetaker-secret");
  assert.equal(res.status, 502);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, "ledger unavailable");
});

test("a fresh delivery is queued and the run is kicked to start immediately", async () => {
  reset();
  const payload = { meeting_id: "m-1", title: "Product sync", transcript: "Alex will send the proposal." };
  const res = await receiveWorkflowWebhook(req(payload), "wf-1", "notetaker-secret");

  assert.equal(res.status, 202);
  const body = (await res.json()) as { status: string; run_id: string; duplicate: boolean };
  assert.equal(body.status, "queued");
  assert.equal(body.duplicate, false);
  assert.equal(body.run_id, "run-1");
  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0]!.workflowId, "wf-1");
  assert.deepEqual(claimCalls[0]!.input, payload);
  assert.deepEqual(kickCalls, ["run-1"]);
});

test("a duplicate delivery is reported without kicking a second run", async () => {
  reset();
  claimResult = { runId: "run-1", status: "queued", duplicate: true };
  const res = await receiveWorkflowWebhook(req({ meeting_id: "m-1" }), "wf-1", "notetaker-secret");
  assert.equal(res.status, 202);
  const body = (await res.json()) as { status: string; duplicate: boolean };
  assert.equal(body.status, "duplicate");
  assert.equal(body.duplicate, true);
  assert.equal(kickCalls.length, 0, "the delivery that started the original run was already kicked");
});

test("meet.doubtbuddy.com's retried delivery collapses to one claim via its explicit delivery header", async () => {
  reset();
  const payload = { meeting_id: "m-7", event: "transcription.completed" };
  await receiveWorkflowWebhook(
    req(payload, { headers: { "x-webhook-id": "delivery-42" } }),
    "wf-1",
    "notetaker-secret",
  );
  assert.equal(claimCalls[0]!.idempotencyKey, "webhook:delivery-42");
});
