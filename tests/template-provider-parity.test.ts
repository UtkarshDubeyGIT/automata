import assert from "node:assert/strict";
import { test } from "node:test";
import { TEMPLATES } from "@/lib/workflows/templates";

test("the Shopify weekly report calls the order-list tool without unsupported arguments", () => {
  const step = TEMPLATES.flatMap((template) => Object.values(template.graph.steps))
    .find((candidate) => candidate.tool === "SHOPIFY_GET_ORDER_LIST");
  assert.ok(step);
  assert.deepEqual(step.arguments, {});
});

test("the Shopify WhatsApp alert delivers through the verified workflow reminder connection", () => {
  const template = TEMPLATES.find((candidate) => candidate.id === "shopify-order-whatsapp");
  assert.ok(template);
  const step = template.graph.steps.send_alert;
  assert.equal(step.type, "whatsapp_reminder");
  assert.equal(step.message, "{{steps.write_alert.result.message}}");
});
