import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const listRoute = readFileSync("src/app/api/workflows/route.ts", "utf8");
const listPage = readFileSync("src/app/app/workflows/page.tsx", "utf8");
const editor = readFileSync("src/app/app/workflows/[id]/page.tsx", "utf8");
const dialogPath = "src/components/workflow-activation-dialog.tsx";
const dialog = existsSync(dialogPath) ? readFileSync(dialogPath, "utf8") : "";

test("switching an automation on is confirmed from both activation controls", () => {
  assert.match(listRoute, /externalActions: row\.config\?\.graph \? liveWrites\(row\.config\.graph\) : \[\]/);
  assert.match(listPage, /<WorkflowActivationDialog/);
  assert.match(editor, /<WorkflowActivationDialog/);
});

test("the activation confirmation plainly names external actions", () => {
  assert.match(dialog, /This automation can take actions outside Automata\./);
  assert.match(dialog, /externalActions\.map/);
  assert.match(dialog, /Start automation/);
  assert.match(dialog, /Cancel/);
});
