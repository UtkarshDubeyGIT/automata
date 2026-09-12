import { strict as assert } from "node:assert";
import { test } from "node:test";
import { webhookDeliveryIdentity } from "@/lib/workflows/webhook-receiver";

test("Notetaker retries collapse by meeting identity and event type", () => {
  assert.equal(webhookDeliveryIdentity(new Headers(), {
    meeting_id: "meeting-42",
    event: "transcription.completed",
  }), "meeting-42:transcription.completed");
});

test("explicit delivery headers take precedence over payload fallbacks", () => {
  assert.equal(webhookDeliveryIdentity(new Headers({ "x-delivery-id": "delivery-7" }), {
    meeting_id: "meeting-42",
    event: "transcription.completed",
  }), "delivery-7");
});
