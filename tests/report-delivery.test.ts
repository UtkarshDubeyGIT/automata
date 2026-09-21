import { strict as assert } from "node:assert";
import { test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import {
  claimReportDelivery,
  deliveryIdentity,
  expireReportDeliveries,
  transitionReportDelivery,
  type ReportDelivery,
} from "@/lib/workflows/report-delivery";

test("delivery identity includes workspace, run, step, account, and recipient", () => {
  assert.equal(
    deliveryIdentity({
      workspaceId: "ws-1",
      runId: "run-1",
      stepId: "send",
      destinationAccountId: "gmail-1",
      recipient: "owner@example.com",
    }),
    "ws-1:run-1:send:gmail-1:owner@example.com",
  );
});

test("concurrent delivery claims yield one pending delivery", async () => {
  const db = new FakeDb();
  const input = {
    workspaceId: "ws-1",
    runId: "run-1",
    stepId: "send",
    destinationAccountId: "slack-1",
    recipient: "C123",
    payload: { text: "report" },
  };
  const [first, second] = await Promise.all([
    claimReportDelivery(db, input),
    claimReportDelivery(db, input),
  ]);
  assert.equal(db.table("workflow_report_deliveries").length, 1);
  assert.equal(first.created || second.created, true);
  assert.equal(first.delivery.id, second.delivery.id);
});

test("a sent or unknown delivery is never claimed as a fresh send", async () => {
  const db = new FakeDb();
  const input = {
    workspaceId: "ws-1",
    runId: "run-1",
    stepId: "send",
    destinationAccountId: "gmail-1",
    recipient: "owner@example.com",
    payload: { text: "report" },
  };
  const claimed = await claimReportDelivery(db, input);
  await db.from("workflow_report_deliveries").update({ status: "sent" }).eq("id", claimed.delivery.id);
  const again = await claimReportDelivery(db, input);
  assert.equal(again.created, false);
  assert.equal((again.delivery as ReportDelivery).status, "sent");
});

test("an abandoned claim becomes unknown instead of being retried", async () => {
  const db = new FakeDb();
  const claimed = await claimReportDelivery(db, {
    workspaceId: "ws-1",
    runId: "run-1",
    stepId: "send",
    destinationAccountId: "gmail-1",
    recipient: "owner@example.com",
    payload: { text: "report" },
  });
  await transitionReportDelivery(db, claimed.delivery.id, "sending");
  await expireReportDeliveries(db, new Date(Date.now() + 16 * 60_000));
  const again = await claimReportDelivery(db, {
    workspaceId: "ws-1",
    runId: "run-1",
    stepId: "send",
    destinationAccountId: "gmail-1",
    recipient: "owner@example.com",
    payload: { text: "report" },
  });
  assert.equal(again.created, false);
  assert.equal(again.delivery.status, "unknown");
});
