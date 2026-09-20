import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync("src/app/app/workflows/[id]/page.tsx", "utf8");
const brandReadiness = readFileSync("src/components/brand-readiness.tsx", "utf8");

test("workflow notices use compact rows and reserve actions for resolvable issues", () => {
  assert.match(editor, /data-workflow-notice="refresh"/);
  assert.match(editor, /data-workflow-notice="publish"/);
  assert.match(editor, /data-workflow-notice="limits"/);
  assert.match(editor, /className="flex min-w-0 items-center gap-2 border-b border-warning-border\/70 py-2 text-\[12px\]"/);
  assert.match(editor, /limit\.stepId \? \(/);
  assert.match(editor, /onClick=\{\(\) => setSelectedId\(limit\.stepId \?\? null\)\}/);
  assert.doesNotMatch(editor, /Worth knowing before you switch this on/);
  assert.match(brandReadiness, /data-brand-notice/);
  assert.match(brandReadiness, /Add details/);
});
