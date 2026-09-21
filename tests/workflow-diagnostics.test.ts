import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import {
  recordWorkflowBuildEvent,
  sanitizeDiagnosticEvent,
  purgeWorkflowBuildEvents,
} from "@/lib/workflows/diagnostics";

test("diagnostic fields allowlist identifiers and redact content-like values", () => {
  const safe = sanitizeDiagnosticEvent({
    eventType: "build_failed",
    stage: "model",
    workspaceId: "ws-1",
    correlationId: "corr-1",
    buildJobId: "job-1",
    actorId: "actor-1",
    attempt: 2,
    durationMs: 123,
    errorCode: "provider_timeout",
    metadata: {
      workflowId: "wf-1",
      prompt: "ignore this prompt",
      body: "message body",
      provider: "openai",
    },
  });
  assert.deepEqual(safe.metadata, { workflowId: "wf-1", provider: "openai" });
  assert.equal(safe.event_type, "build_failed");
  assert.equal(safe.attempt, 2);
});

test("terminal diagnostic events are idempotent and never throw on a logger outage", async () => {
  const db = new FakeDb();
  const event = {
    workspaceId: "ws-1",
    correlationId: "corr-1",
    buildJobId: "job-1",
    eventType: "workflow_created" as const,
    stage: "save" as const,
    metadata: { workflowId: "wf-1" },
  };
  await recordWorkflowBuildEvent(db, event);
  await recordWorkflowBuildEvent(db, event);
  assert.equal(db.table("workflow_build_events").length, 1);
  const broken = { from: () => { throw new Error("logger unavailable"); } };
  await assert.doesNotReject(recordWorkflowBuildEvent(broken, event));
});

test("diagnostic retention deletes only events older than the retention window", async () => {
  const db = new FakeDb();
  db.seed(
    "workflow_build_events",
    { id: "old", workspace_id: "ws-1", created_at: "2026-08-01T00:00:00.000Z" },
    { id: "new", workspace_id: "ws-1", created_at: "2026-09-20T00:00:00.000Z" },
  );
  await purgeWorkflowBuildEvents(db, new Date("2026-09-21T00:00:00.000Z"));
  assert.deepEqual(db.table("workflow_build_events").map((row) => row.id), ["new"]);
});
