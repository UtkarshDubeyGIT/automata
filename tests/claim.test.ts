import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * The two properties the whole plan exists for, against a fake store AND a
 * fake ledger — because neither can be shown with a pure function:
 *
 *   1. Two claims on one due slot produce ONE run and ONE charge.
 *   2. A queued run replays against the graph it was CLAIMED with, not
 *      whatever the editor has saved since.
 *
 * `credits.ts` reaches for createAdminClient() itself, so the module is
 * mocked rather than injected. Everything else is real code.
 */

const db = new FakeDb();

mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => db,
    createClient: async () => db,
  },
});

const { claimRun, claimForDriving, scheduleKey, manualKey } = await import("@/lib/workflows/claim");
const { drainRuns } = await import("@/lib/workflows/drain");
const { getBalance } = await import("@/lib/credits");

const WORKSPACE = "ws-1";
const WORKFLOW = "wf-1";

function reset(graph: WorkflowGraph) {
  db.replace("workflow_runs", []);
  db.replace("credit_ledger", []);
  db.replace("workflows", []);
  db.seed("workflows", {
    id: WORKFLOW,
    workspace_id: WORKSPACE,
    active: true,
    config: { v: 1, graph, display: { groups: [] } },
  });
  // Enough to pay for several runs.
  db.seed("credit_ledger", {
    workspace_id: WORKSPACE,
    delta: 100,
    reason: "signup_bonus",
  });
}

const trivial: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "schedule_trigger", cadence: "daily", hour: 9, next: "note" },
    note: { type: "log_action", label: "original", message: "the first graph", next: null },
  },
};

test("two concurrent claims on one slot produce one run and one charge", async () => {
  reset(trivial);
  const slot = new Date("2026-08-27T09:00:00.000Z");
  const key = scheduleKey(slot);

  // Two beats racing a stale lastFiredAt. They compute the SAME key, which is
  // the point of keying off the slot rather than floor(now / 15min).
  const [a, b] = await Promise.all([
    claimRun({
      admin: db,
      workflowId: WORKFLOW,
      workspaceId: WORKSPACE,
      graph: trivial,
      idempotencyKey: key,
      mode: "enqueue",
    }),
    claimRun({
      admin: db,
      workflowId: WORKFLOW,
      workspaceId: WORKSPACE,
      graph: trivial,
      idempotencyKey: key,
      mode: "enqueue",
    }),
  ]);

  assert.equal(a.runId, b.runId, "two runs were created for one slot");
  assert.equal(a.duplicate !== b.duplicate, true, "exactly one claim should be the duplicate");
  assert.equal(db.table("workflow_runs").length, 1);

  // One charge, not two. spendCredits used to collapse the unique violation
  // into { ok: false }, which surfaced as "not enough credits".
  const debits = db.table("credit_ledger").filter((r) => r.reason === "workflow_run");
  assert.equal(debits.length, 1);
  assert.equal(await getBalance(WORKSPACE), 98);
});

test("a slot already fired is never charged again, however many times it is claimed", async () => {
  reset(trivial);
  const key = scheduleKey(new Date("2026-08-27T09:00:00.000Z"));
  for (let i = 0; i < 4; i++) {
    await claimRun({
      admin: db,
      workflowId: WORKFLOW,
      workspaceId: WORKSPACE,
      graph: trivial,
      idempotencyKey: key,
      mode: "enqueue",
    });
  }
  assert.equal(db.table("workflow_runs").length, 1);
  assert.equal(await getBalance(WORKSPACE), 98);
});

test("a claim with an empty balance settles the row failed, not queued", async () => {
  reset(trivial);
  // Spend the balance down to nothing.
  db.replace("credit_ledger", []);

  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: trivial,
    idempotencyKey: manualKey("nonce-1"),
    mode: "enqueue",
  });

  assert.equal(claim.refused?.reason, "insufficient_credits");
  assert.equal(claim.status, "failed");
  // A `queued` row nobody paid for would be picked up and run for free.
  const row = db.table("workflow_runs")[0];
  assert.equal(row.status, "failed");
  // And the refused debit was reversed, so the balance is back where it was.
  assert.equal(await getBalance(WORKSPACE), 0);
});

test("a queued run replays against the graph it was claimed with", async () => {
  reset(trivial);

  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: trivial,
    idempotencyKey: manualKey("nonce-graph"),
    mode: "enqueue",
  });
  assert.equal(claim.status, "queued");

  // The user edits the automation while the run sits in the queue. This is the
  // window the in-request path never had, and the hazard the snapshot exists
  // to close: replaying a part-executed run against a DIFFERENT graph makes
  // routing diverge from the journal and re-reaches published steps under new
  // ids.
  const edited: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { type: "schedule_trigger", cadence: "daily", hour: 9, next: "note" },
      note: { type: "log_action", label: "edited", message: "the SECOND graph", next: null },
    },
  };
  const workflow = db.table("workflows")[0];
  workflow.config = { v: 1, graph: edited, display: { groups: [] } };

  const drained = await drainRuns(db, { deadline: Date.now() + 10_000 });
  assert.equal(drained.driven, 1);
  assert.equal(drained.completed, 1);

  const row = db.table("workflow_runs")[0];
  assert.equal(row.status, "completed");
  const log = row.log as { journal: { stepId: string; output: Record<string, unknown> }[] };
  const note = log.journal.find((j) => j.stepId === "note")!;
  assert.equal(note.output.message, "the first graph", "the run used the edited graph");
  assert.equal(note.output.performed, "original");

  // And the edit does apply to the NEXT run.
  const next = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: edited,
    idempotencyKey: manualKey("nonce-graph-2"),
    mode: "execute",
  });
  assert.equal(next.status, "completed");
  const second = db.table("workflow_runs").find((r) => r.id === next.runId)!;
  const secondLog = second.log as { journal: { stepId: string; output: Record<string, unknown> }[] };
  assert.equal(
    secondLog.journal.find((j) => j.stepId === "note")!.output.message,
    "the SECOND graph",
  );
});

test("a failed run is refunded when nothing real happened", async () => {
  reset({
    start: "trigger",
    steps: {
      trigger: { type: "schedule_trigger", cadence: "daily", hour: 9, next: "boom" },
      // No such tool, so app_action throws before touching a provider.
      boom: { type: "app_action", tool: "NOT_A_REAL_TOOL", next: null },
    },
  });

  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: (db.table("workflows")[0].config as { graph: WorkflowGraph }).graph,
    idempotencyKey: manualKey("nonce-fail"),
    mode: "execute",
  });

  assert.equal(claim.status, "failed");
  const row = db.table("workflow_runs")[0];
  assert.equal((row.log as { failed?: { stepId: string } }).failed?.stepId, "boom");
  // Charged 2, refunded 2.
  assert.equal(await getBalance(WORKSPACE), 100);
  assert.equal(db.table("credit_ledger").filter((r) => r.reason === "refund").length, 1);
});

test("only one driver can claim a run, so an approval and a beat cannot both publish", async () => {
  reset(trivial);
  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: trivial,
    idempotencyKey: manualKey("nonce-cas"),
    mode: "enqueue",
  });
  assert.equal(claim.status, "queued");

  // The decision route and the beat's drain reach for the same row at once.
  const [a, b] = await Promise.all([
    claimForDriving(db, claim.runId),
    claimForDriving(db, claim.runId),
  ]);

  // Exactly one wins. Both winning would mean both replay to the same cursor
  // and both execute the publish — the one failure this design exists to stop.
  const winners = [a, b].filter(Boolean);
  assert.equal(winners.length, 1, "two drivers claimed the same run");
  assert.equal(winners[0]!.graph?.start, "trigger", "the winner gets the graph snapshot");
});

test("a run already being driven is not stealable until its heartbeat goes stale", async () => {
  reset(trivial);
  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph: trivial,
    idempotencyKey: manualKey("nonce-heartbeat"),
    mode: "enqueue",
  });

  assert.ok(await claimForDriving(db, claim.runId), "the first driver wins");
  // A second driver a moment later must be turned away.
  assert.equal(await claimForDriving(db, claim.runId), null);

  // Six minutes on, with no journal write, the claim is assumed dead.
  const later = new Date(Date.now() + 6 * 60_000);
  assert.ok(await claimForDriving(db, claim.runId, later), "a stale claim is reclaimable");
});
