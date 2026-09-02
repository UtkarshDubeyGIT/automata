import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the workflow editor does not expose or implement isolated module tests", () => {
  const builder = readFileSync("src/components/workflow/workflow-builder.tsx", "utf8");
  const page = readFileSync("src/app/app/workflows/[id]/page.tsx", "utf8");
  const styles = readFileSync("src/app/globals.css", "utf8");
  const migration = readFileSync("supabase/migrations/20260901161922_workflow_editor_drafts.sql", "utf8");

  assert.doesNotMatch(builder, /Test this module|testSelectedStep|test-step/);
  assert.doesNotMatch(page, /workflow_step_samples|initialObservedFields/);
  assert.doesNotMatch(styles, /inspector-test/);
  assert.equal(existsSync("src/app/api/workflows/[id]/test-step/route.ts"), false);
  assert.doesNotMatch(migration, /workflow_step_samples/);
});
