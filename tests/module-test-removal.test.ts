import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

test("the workflow editor does not expose or implement isolated module tests", () => {
  const inspector = readFileSync("src/app/(app)/workflows/[id]/inspector.tsx", "utf8");
  const page = readFileSync("src/app/(app)/workflows/[id]/page.tsx", "utf8");
  const migration = existsSync("supabase/migrations/20260901172234_workflow_editor_drafts.sql")
    ? readFileSync("supabase/migrations/20260901172234_workflow_editor_drafts.sql", "utf8")
    : readFileSync("supabase/migrations/20260901161922_workflow_editor_drafts.sql", "utf8");

  assert.doesNotMatch(inspector, /Test this module|Test step|Module test input JSON/);
  assert.doesNotMatch(page, /test-step|testingStep|testStep/);
  assert.equal(existsSync("src/app/api/workflows/[id]/test-step/route.ts"), false);
  assert.doesNotMatch(migration, /workflow_step_samples/);
});
