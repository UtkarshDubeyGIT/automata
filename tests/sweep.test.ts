import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * The trigger sweep, against the fake store. These are the properties that
 * decide whether an unattended automation runs the right number of times.
 */

const db = new FakeDb();
mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => db, createClient: async () => db },
});

const { sweepTriggers } = await import("@/lib/workflows/sweep");
const { getBalance } = await import("@/lib/credits");

const WORKSPACE = "ws-1";
const WORKFLOW = "wf-1";

const scheduled: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "schedule_trigger", cadence: "daily", hour: 9, next: "note" },
    note: { type: "log_action", label: "note", message: "ran", next: null },
  },
};

function reset(triggerState: Record<string, unknown> | null = null) {
  db.replace("workflow_runs", []);
  db.replace("credit_ledger", []);
  db.replace("workflows", []);
  db.replace("agent_settings", []);
  db.seed("workflows", {
    id: WORKFLOW,
    workspace_id: WORKSPACE,
    active: true,
    config: { v: 1, graph: scheduled, display: { groups: [] } },
    trigger_state: triggerState,
  });
  db.seed("agent_settings", { workspace_id: WORKSPACE, timezone: "UTC" });
  db.seed("credit_ledger", { workspace_id: WORKSPACE, delta: 100, reason: "signup_bonus" });
}

test("two beats running at once fire one run and take one charge", async () => {
  reset();
  const now = new Date("2026-08-27T10:00:00Z");
  const [a, b] = await Promise.all([
    sweepTriggers(db, { now, deadline: Date.now() + 10_000 }),
    sweepTriggers(db, { now, deadline: Date.now() + 10_000 }),
  ]);
  // Both beats see the same stale lastFiredAt and both decide the slot is due.
  // They agree because the KEY is the slot, not the moment.
  assert.equal(a.checked + b.checked, 2);
  assert.equal(db.table("workflow_runs").length, 1, "two beats created two runs");
  assert.equal(await getBalance(WORKSPACE), 98);
});

test("the sweep enqueues rather than executing, and records the slot it fired", async () => {
  reset();
  await sweepTriggers(db, { now: new Date("2026-08-27T10:00:00Z"), deadline: Date.now() + 10_000 });
  const run = db.table("workflow_runs")[0];
  // Unattended work belongs off the request path — nginx closes the proxy at
  // 60s whatever `maxDuration` claims.
  assert.equal(run.status, "queued");
  assert.equal(run.idempotency_key, "schedule:2026-08-27T09:00:00.000Z");
  // The graph is snapshotted at claim time, so an edit can't rewrite history.
  assert.ok((run.graph as WorkflowGraph)?.start);

  const state = db.table("workflows")[0].trigger_state as { lastFiredAt: string };
  assert.equal(state.lastFiredAt, "2026-08-27T09:00:00.000Z");
});

test("a second beat in the same slot fires nothing more", async () => {
  reset();
  await sweepTriggers(db, { now: new Date("2026-08-27T10:00:00Z"), deadline: Date.now() + 10_000 });
  const second = await sweepTriggers(db, {
    now: new Date("2026-08-27T14:00:00Z"),
    deadline: Date.now() + 10_000,
  });
  assert.equal(second.fired, 0);
  assert.equal(db.table("workflow_runs").length, 1);
  assert.equal(await getBalance(WORKSPACE), 98);
});

test("a beat that runs late fires the slot it missed, once", async () => {
  reset({ lastFiredAt: "2026-08-25T09:00:00.000Z", lastCheckedAt: "2026-08-25T09:00:00.000Z" });
  // Down all of the 26th; back at 23:00.
  await sweepTriggers(db, { now: new Date("2026-08-26T23:00:00Z"), deadline: Date.now() + 10_000 });
  assert.equal(db.table("workflow_runs").length, 1);
  assert.equal(db.table("workflow_runs")[0].idempotency_key, "schedule:2026-08-26T09:00:00.000Z");
});

test("a paused automation is never swept", async () => {
  reset();
  db.table("workflows")[0].active = false;
  const result = await sweepTriggers(db, {
    now: new Date("2026-08-27T10:00:00Z"),
    deadline: Date.now() + 10_000,
  });
  assert.equal(result.swept, 0);
  assert.equal(db.table("workflow_runs").length, 0);
});

test("a workflow Composio is already watching is not also polled", async () => {
  reset({ realtime: { mode: "realtime", instanceId: "ti_123", at: "2026-08-27T09:00:00.000Z" } });
  db.table("workflows")[0].config = {
    v: 1,
    display: { groups: [] },
    graph: {
      start: "trigger",
      steps: {
        trigger: {
          type: "app_event_trigger",
          event: "NEW_GITHUB_ISSUE",
          watch_owner: "vercel",
          watch_repo: "next.js",
          next: null,
        },
      },
    },
  };
  const result = await sweepTriggers(db, {
    now: new Date("2026-08-27T10:00:00Z"),
    deadline: Date.now() + 10_000,
  });
  // A poll keys off the record id and a push keys off the delivery id, so the
  // same event arriving both ways would be two runs.
  assert.equal(result.fired, 0);
  assert.equal(db.table("workflow_runs").length, 0);
  const state = db.table("workflows")[0].trigger_state as { lastCheckedAt: string };
  assert.ok(state.lastCheckedAt, "it should still record that it looked");
});
