import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import { demoteToPolling } from "@/lib/workflows/realtime";
import type { TriggerState } from "@/lib/workflows/types";

/**
 * What happens when Composio stops watching without being asked.
 *
 * The sweep will not poll a workflow it believes is being pushed to, because a
 * poll keys off the record id and a push off the delivery id — the same event
 * arriving both ways would be two runs and two charges. That refusal is
 * correct, and it rests entirely on `trigger_state.realtime` still describing
 * reality. Composio disabling an instance on its own (expired auth, a webhook
 * subscription it can no longer refresh) breaks that assumption, and the
 * result is the worst failure this system has: no push, no poll, and a header
 * still reporting a fresh "last checked" because the skip branch clears
 * `lastError` on every pass. The automation looks healthy and does nothing.
 */

const watching: TriggerState = {
  realtime: { mode: "realtime", instanceId: "ti_abc123", slug: "GITHUB_ISSUE_ADDED_EVENT", channel: "webhook", at: "2026-08-01T00:00:00Z" },
  cursor: "412",
  lastCheckedAt: "2026-08-28T09:00:00Z",
};

function dbWithWorkflow(state: TriggerState = watching) {
  const db = new FakeDb();
  db.seed(
    "workflows",
    { id: "wf_1", workspace_id: "ws_1", active: true, trigger_state: state },
    // A second, healthy workflow on a different instance: the demotion must
    // land on exactly one row, or one expired account silently slows every
    // real-time automation in the project.
    {
      id: "wf_2",
      workspace_id: "ws_1",
      active: true,
      trigger_state: {
        realtime: { mode: "realtime", instanceId: "ti_other", at: "2026-08-01T00:00:00Z" },
      } as TriggerState,
    },
  );
  return db;
}

test("a watch Composio switched off puts the workflow back on polling", async () => {
  const db = dbWithWorkflow();
  const id = await demoteToPolling(db, "ti_abc123", "Composio stopped watching this account.");
  assert.equal(id, "wf_1");

  const row = db.table("workflows").find((r) => r.id === "wf_1")!;
  const state = row.trigger_state as TriggerState;

  /*
   * These two assertions ARE the fix. sweep.ts skips a workflow when
   * `realtime.mode === "realtime" && realtime.instanceId` — so both halves have
   * to stop being true, or the sweep goes on ignoring a workflow nothing is
   * watching.
   */
  assert.equal(state.realtime?.mode, "poll");
  assert.equal(state.realtime?.instanceId, undefined);
  assert.match(state.realtime?.reason ?? "", /checked on a schedule|stopped watching/i);
});

test("demoting keeps the cursor, so resuming does not replay the backlog", async () => {
  /*
   * The cursor was set by a real poll and still names a real record, so the
   * next sweep resumes from it. Clearing it would baseline instead and lose
   * whatever arrived during the outage; inventing one would be worse, because
   * `untilCursor` reads a cursor it cannot find as "the page moved past it"
   * and hands back the WHOLE page — one run per pre-existing record.
   */
  const db = dbWithWorkflow();
  await demoteToPolling(db, "ti_abc123", "Composio stopped watching this account.");
  const state = db.table("workflows").find((r) => r.id === "wf_1")!.trigger_state as TriggerState;
  assert.equal(state.cursor, "412");
  assert.equal(state.lastCheckedAt, "2026-08-28T09:00:00Z");
});

test("only the workflow that owns that instance is touched", async () => {
  const db = dbWithWorkflow();
  await demoteToPolling(db, "ti_abc123", "Composio stopped watching this account.");
  const other = db.table("workflows").find((r) => r.id === "wf_2")!.trigger_state as TriggerState;
  assert.equal(other.realtime?.mode, "realtime");
  assert.equal(other.realtime?.instanceId, "ti_other");
});

test("a delivery for a watch we no longer own changes nothing", async () => {
  // The workflow was deleted, or the instance belongs to another project. The
  // route answers 200 either way — a 4xx just makes Composio retry a delivery
  // nothing will ever want.
  const db = dbWithWorkflow();
  const id = await demoteToPolling(db, "ti_unknown", "Composio stopped watching this account.");
  assert.equal(id, null);
  const state = db.table("workflows").find((r) => r.id === "wf_1")!.trigger_state as TriggerState;
  assert.equal(state.realtime?.mode, "realtime");
});
