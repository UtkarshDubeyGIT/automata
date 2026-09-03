import assert from "node:assert/strict";
import test from "node:test";

import { requiredAppsOf } from "@/lib/workflows/apps";
import { getTemplate } from "@/lib/workflows/templates";

test("the Shopify WhatsApp template is an operational owner notification", () => {
  const template = getTemplate("shopify-order-whatsapp");
  assert.ok(template, "the template is available in the Automations gallery");
  assert.doesNotMatch(template.description, /\b(moment|instant(?:ly)?)\b/i);

  const trigger = template.graph.steps[template.graph.start];
  assert.equal(trigger.type, "app_event_trigger");
  assert.equal(trigger.event, "NEW_SHOPIFY_ORDER");

  const writer = Object.values(template.graph.steps).find((step) => step.type === "ai_step");
  assert.ok(writer);
  assert.match(String(writer.instruction), /operational notification/i);
  assert.match(String(writer.instruction), /do not add a promotion/i);

  const sender = Object.values(template.graph.steps).find(
    (step) => step.type === "app_action" && step.tool === "WHATSAPP_SEND_MESSAGE",
  );
  assert.ok(sender);
  const arguments_ = (sender.arguments ?? {}) as Record<string, unknown>;
  assert.equal(arguments_.to_number, "", "the owner chooses their own recipient number");

  assert.deepEqual(
    requiredAppsOf(template.graph).map((app) => app.app),
    ["shopify", "whatsapp"],
  );
});
