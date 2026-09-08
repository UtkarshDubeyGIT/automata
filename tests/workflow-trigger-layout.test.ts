import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const inspector = readFileSync("src/app/app/workflows/[id]/inspector.tsx", "utf8");

test("the trigger inspector keeps its copy clear of the action buttons", () => {
  const triggerPanel = inspector.match(/\{spec\.trigger && \([\s\S]*?\n        \)\}/)?.[0] ?? "";

  assert.match(triggerPanel, /className="flex flex-col gap-3"/);
  assert.doesNotMatch(triggerPanel, /sm:flex-row sm:items-start/);
  assert.match(triggerPanel, /className="flex flex-wrap gap-2"/);
});
