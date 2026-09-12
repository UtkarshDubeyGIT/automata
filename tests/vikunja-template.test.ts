import { strict as assert } from "node:assert";
import { test } from "node:test";
import { getTemplate } from "@/lib/workflows/templates";
import { validateGraph } from "@/lib/workflows/validate";

test("Notetaker to Vikunja template extracts structured items and creates tasks", () => {
  const template = getTemplate("notetaker-vikunja-tasks");
  assert.ok(template);
  assert.deepEqual(template.apps, ["vikunja"]);
  const extraction = template.graph.steps.extract_actions;
  const create = template.graph.steps.create_tasks;
  assert.equal(extraction?.type, "meeting_summary");
  assert.equal(extraction?.extract_action_items, true);
  assert.equal(create?.tool, "VIKUNJA_CREATE_TASKS");
  assert.equal((create?.arguments as Record<string, unknown>).items, "{{steps.extract_actions.actionItems}}");
  assert.equal((create?.arguments as Record<string, unknown>).project_id, "");
  assert.doesNotThrow(() => validateGraph(template.graph));
});
