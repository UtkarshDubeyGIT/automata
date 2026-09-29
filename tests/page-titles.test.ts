import assert from "node:assert/strict";
import test from "node:test";

import { BRAND } from "@/config/brand";
import { pageTitle, workflowTabTitle } from "@/lib/page-titles";

test("page titles put the app brand after the page name", () => {
  assert.equal(pageTitle("Settings"), `Settings | ${BRAND.name}`);
});

test("workflow tab titles cover each tab and default unknown tabs to create", () => {
  assert.equal(workflowTabTitle("create"), "Create a Workflow");
  assert.equal(workflowTabTitle("workflows"), "Workflows");
  assert.equal(workflowTabTitle("runs"), "Run History");
  assert.equal(workflowTabTitle("attention"), "Needs Your Attention");
  assert.equal(workflowTabTitle("unexpected"), "Create a Workflow");
  assert.equal(workflowTabTitle(null), "Create a Workflow");
});
