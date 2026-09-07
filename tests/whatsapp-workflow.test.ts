import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { FakeDb } from "./helpers/fake-supabase";

import { CATEGORY_LABELS, NODE_TYPES, palette } from "@/lib/workflows/blocks";
import {
  canReceiveWorkflowReminder,
  nextDeliveryStatus,
  normalizeTwilioStatus,
  retryDelayMs,
  sanitizeWhatsAppMessage,
} from "@/lib/whatsapp/core";

test("WhatsApp reminders are a first-class notification workflow node", () => {
  const block = palette().find((candidate) => candidate.id === "notification:whatsapp");

  assert.equal((CATEGORY_LABELS as Record<string, string>).notification, "Notifications");
  assert.equal(block?.type, "whatsapp_reminder");
  assert.equal(block?.category, "notification");
  assert.equal(NODE_TYPES.whatsapp_reminder.label, "Send WhatsApp reminder");
  assert.equal(NODE_TYPES.whatsapp_reminder.fields.some((field) => field.key === "message" && field.templated), true);
  assert.deepEqual(
    NODE_TYPES.whatsapp_reminder.outputs?.({ type: "whatsapp_reminder" }).map((output) => output.path),
    ["delivery_id", "status"],
  );
});

test("workflow reminders require verification, consent, enablement, and the workflow preference", () => {
  const ready = {
    phone_e164: "+919876543210",
    verified_at: "2026-09-03T10:00:00.000Z",
    consented_at: "2026-09-03T10:01:00.000Z",
    enabled: true,
    workflow_reminders: true,
  };

  assert.deepEqual(canReceiveWorkflowReminder(ready), { allowed: true });
  assert.equal(canReceiveWorkflowReminder({ ...ready, verified_at: null }).allowed, false);
  assert.equal(canReceiveWorkflowReminder({ ...ready, consented_at: null }).allowed, false);
  assert.equal(canReceiveWorkflowReminder({ ...ready, enabled: false }).allowed, false);
  assert.equal(canReceiveWorkflowReminder({ ...ready, workflow_reminders: false }).allowed, false);
});

test("delivery status callbacks only move forward even when Twilio sends them out of order", () => {
  assert.equal(nextDeliveryStatus("queued", "sent"), "sent");
  assert.equal(nextDeliveryStatus("delivered", "sent"), "delivered");
  assert.equal(nextDeliveryStatus("read", "delivered"), "read");
  assert.equal(nextDeliveryStatus("delivered", "undelivered"), "delivered");
  assert.equal(normalizeTwilioStatus("accepted"), "queued");
});

test("messages are plain, bounded, and retries use capped exponential backoff", () => {
  assert.equal(sanitizeWhatsAppMessage("  <b>Hello</b>\u0000   team  "), "Hello team");
  assert.equal(sanitizeWhatsAppMessage("x".repeat(1_200)).length, 1_000);
  assert.deepEqual([1, 2, 3, 9].map(retryDelayMs), [60_000, 120_000, 240_000, 3_600_000]);
});

test("duplicate workflow node execution returns the original durable delivery", async () => {
  const db = new FakeDb();
  db.seed("workspaces", { id: "workspace-1", owner_id: "user-1" });
  db.seed("whatsapp_profiles", {
    workspace_id: "workspace-1", user_id: "user-1", phone_e164: "+919876543210",
    verified_at: "2026-09-03T10:00:00.000Z", consented_at: "2026-09-03T10:01:00.000Z",
    enabled: true, workflow_reminders: true,
  });
  mock.module("@/lib/supabase/server", {
    namedExports: { createAdminClient: () => db, createClient: async () => db },
  });
  const { queueWorkflowReminder } = await import("@/lib/whatsapp/service");
  const input = { workspaceId: "workspace-1", runId: "run-1", stepId: "notify", body: "Meeting summary" };
  const first = await queueWorkflowReminder(input);
  const duplicate = await queueWorkflowReminder(input);

  assert.equal(first.deliveryId, duplicate.deliveryId);
  assert.equal(db.table("message_deliveries").length, 1);
});

test("a queued live WhatsApp reminder prevents a clean-run refund", () => {
  return import("@/lib/workflows/runtime").then(({ hadRealSideEffect }) => assert.equal(hadRealSideEffect({
    v: 1,
    journal: [{ stepId: "notify", type: "whatsapp_reminder", title: "Notify", status: "done", output: { successful: true }, at: new Date().toISOString() }],
    context: { steps: {}, input: {} },
  }), true));
});
