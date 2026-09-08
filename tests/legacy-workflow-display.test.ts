import assert from "node:assert/strict";
import test from "node:test";
import { toWorkflowView, type WorkflowRow } from "@/lib/workflows/display";

test("a preserved legacy workflow displays its compatible draft while its older published format awaits migration", () => {
  const row = {
    id: "legacy-workflow", name: "Saved draft", active: false, config: {},
    draft_config: { v: 1, graph: { start: "start", steps: { start: { type: "manual_trigger", next: null } } } },
    runs: 0,
  } as unknown as WorkflowRow;
  const view = toWorkflowView(row);
  assert.equal(view.active, false);
  assert.equal(view.groups.length, 1);
});

test("an unknown preserved legacy graph does not break the entire workflow list", () => {
  const view = toWorkflowView({ id: "unknown", name: "Old workflow", active: false, config: {}, runs: 0 } as WorkflowRow);
  assert.equal(view.name, "Old workflow");
  assert.deepEqual(view.groups, []);
});
