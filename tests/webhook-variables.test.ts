import { strict as assert } from "node:assert";
import { test } from "node:test";
import { availableRefs } from "@/lib/workflows/edit";
import { interpolate } from "@/lib/workflows/interpolate";
import {
  payloadFields,
  webhookEndpointState,
  webhookRotationNeedsConfirmation,
  webhookSampleForSecret,
} from "@/lib/workflows/webhook-fields";

test("webhook sample fields include nested leaves and keep arrays addressable", () => {
  assert.deepEqual(payloadFields({
    id: "evt_1",
    data: { meeting: { title: "Weekly sync" }, action_items: [{ text: "Ship" }] },
  }), ["id", "data.meeting.title", "data.action_items"]);
});

test("trigger variables resolve nested values and serialize complex values", () => {
  const context = {
    steps: {},
    input: { data: { title: "Weekly sync", items: [{ text: "Ship" }] } },
  };
  assert.equal(interpolate("Title: {{trigger.data.title}}", context), "Title: Weekly sync");
  assert.equal(interpolate("{{trigger.data.items}}", context), '[{"text":"Ship"}]');
});

test("data picker exposes canonical trigger variables for captured webhook paths", () => {
  const graph = {
    start: "hook",
    steps: {
      hook: {
        type: "webhook_trigger" as const,
        sample_fields: ["data.meeting.title", "data.summary"],
        next: "slack",
      },
      slack: { type: "social_post" as const, platform: "slack", text: "", next: null },
    },
  };
  assert.deepEqual(availableRefs(graph, "slack")[0]?.paths.map((path) => path.ref), [
    "{{trigger}}",
    "{{trigger.data.meeting.title}}",
    "{{trigger.data.summary}}",
  ]);
});

test("a paused automation exposes its draft webhook endpoint", () => {
  assert.deepEqual(
    webhookEndpointState({ active: false, draftSecret: "draft", publishedSecret: "published" }),
    { secret: "draft", pendingPublish: false },
  );
});

test("a running automation exposes only its published webhook endpoint", () => {
  assert.deepEqual(
    webhookEndpointState({ active: true, draftSecret: "replacement", publishedSecret: "published" }),
    { secret: "published", pendingPublish: true },
  );
});

test("a newly added webhook on a running automation has no usable endpoint before publish", () => {
  assert.deepEqual(
    webhookEndpointState({ active: true, draftSecret: "draft", publishedSecret: "" }),
    { secret: "", pendingPublish: true },
  );
});

test("only rotating a published live endpoint requires confirmation", () => {
  assert.equal(webhookRotationNeedsConfirmation(false, "published"), false);
  assert.equal(webhookRotationNeedsConfirmation(true, ""), false);
  assert.equal(webhookRotationNeedsConfirmation(true, "published"), true);
});

test("webhook setup only shows a sample captured by the displayed endpoint", () => {
  const sample = { secret: "current", fields: ["email"], receivedAt: "2026-09-03T00:00:00Z" };
  assert.deepEqual(webhookSampleForSecret(sample, "current"), {
    fields: ["email"],
    receivedAt: "2026-09-03T00:00:00Z",
  });
  assert.equal(webhookSampleForSecret(sample, "replacement"), null);
  assert.equal(webhookSampleForSecret({ fields: ["legacy"], receivedAt: "2026-09-02T00:00:00Z" }, "current"), null);
});
