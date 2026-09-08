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
    (step) => step.type === "whatsapp_reminder",
  );
  assert.ok(sender);
  assert.equal(sender.message, "{{steps.write_alert.result.message}}");
  assert.equal(sender.to_number, undefined, "native reminders use the workspace owner's verified profile");
  assert.equal(sender.arguments, undefined, "order customer phone numbers are never passed to the reminder service");

  assert.deepEqual(
    requiredAppsOf(template.graph).map((app) => app.app),
    ["shopify"],
  );
});
