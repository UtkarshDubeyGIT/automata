import assert from "node:assert/strict";
import test from "node:test";

import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { TEMPLATES } from "@/lib/workflows/templates";

test("the MVP catalog contains the agreed thirteen popular services", () => {
  const slugs = INTEGRATIONS.map((integration) => integration.slug);
  assert.deepEqual(slugs.sort(), [
    "airtable",
    "github",
    "gmail",
    "googlecalendar",
    "googledrive",
    "googlesheets",
    "hubspot",
    "linkedin",
    "notion",
    "shopify",
    "slack",
    "telegram",
    "whatsapp",
  ]);
  assert.equal(new Set(slugs).size, slugs.length);
  assert.ok(INTEGRATIONS.every((integration) => integration.verified));
});

test("quick-start templates only reference verified integrations", () => {
  const verified = new Set(INTEGRATIONS.filter((integration) => integration.verified).map((integration) => integration.slug));
  assert.ok(TEMPLATES.length >= 12);

  for (const template of TEMPLATES) {
    for (const app of template.apps) {
      assert.ok(verified.has(app), `${template.name} references unverified app ${app}`);
    }
  }
});

test("templates that contact customers or publish content include an approval step", () => {
  const sensitive = TEMPLATES.filter((template) => template.risk === "external_write");
  assert.ok(sensitive.length > 0);
  for (const template of sensitive) {
    assert.ok(
      Object.values(template.graph.steps).some((step) => step.type === "approval"),
      `${template.name} must include approval`,
    );
  }
});
