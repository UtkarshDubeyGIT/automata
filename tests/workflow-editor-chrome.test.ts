import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync("src/app/app/workflows/[id]/page.tsx", "utf8");
const integrations = readFileSync("src/components/connect-apps.tsx", "utf8");
const canvas = readFileSync("src/app/app/workflows/[id]/canvas.tsx", "utf8");
const chat = readFileSync("src/app/app/workflows/builder-chat.tsx", "utf8");
const inspector = readFileSync("src/app/app/workflows/[id]/inspector.tsx", "utf8");

test("the workflow header exposes one history button instead of duplicate refresh icons", () => {
  assert.equal((editor.match(/aria-label="Undo"/g) ?? []).length, 1);
  assert.equal((editor.match(/aria-label="Redo"/g) ?? []).length, 0);
});

test("connected tools sit beside the workflow name while issues keep the full panel", () => {
  assert.match(
    editor,
    /connectedTools=\{connections\.every\(\(connection\) => connection\.status === "connected"\) \? connections : \[\]\}/,
  );
  assert.match(editor, /<ConnectedAppIcons connections=\{connectedTools\} \/>/);
  assert.match(
    editor,
    /connections\.some\(\(connection\) => connection\.status !== "connected"\)/,
  );
  assert.doesNotMatch(editor, /compact=/);
  assert.match(integrations, /export function ConnectedAppIcons/);
  assert.match(integrations, /\{app\.label\} connected/);
  assert.doesNotMatch(integrations, /if \(compact\)/);
});

test("workflow identity keeps its space before header actions wrap", () => {
  assert.match(editor, /data-workflow-identity/);
  assert.match(editor, /min-w-\[260px\] flex-\[1_1_320px\]/);
  assert.match(editor, /data-workflow-actions/);
  assert.match(editor, /ml-auto flex flex-wrap items-center justify-end gap-2/);
  assert.match(editor, /\[field-sizing:content\]/);
  assert.match(editor, /max-w-\[calc\(100%-60px\)\]/);
  assert.match(integrations, /className="flex flex-none items-center gap-1"/);
  assert.doesNotMatch(integrations, /-space-x/);
});

test("workflow side panels overlay the full-width canvas and can be hidden", () => {
  assert.match(editor, /data-workflow-canvas-shell/);
  assert.match(editor, /absolute inset-y-3 left-3 z-20/);
  assert.match(editor, /absolute inset-y-3 right-3 z-20/);
  assert.match(editor, /aria-label="Hide modules"/);
  assert.match(editor, />\s*Modules\s*<\/Button>/);
});

test("the action picker escapes the inspector and stays readable at narrow widths", () => {
  assert.match(inspector, /createPortal\(/);
  assert.match(inspector, /document\.body/);
  assert.match(inspector, /z-\[100\]/);
  assert.match(inspector, /lg:grid-cols-2/);
  assert.doesNotMatch(inspector, /md:grid-cols-2/);
});

test("app action configuration hides provider JSON and stacks spreadsheet columns", () => {
  assert.doesNotMatch(inspector, /hint=\{selected \? `Arguments:/);
  assert.match(inspector, /Column \{spreadsheetColumnLabel\(columnIndex\)\}/);
  assert.match(inspector, /flex min-w-0 flex-col gap-2/);
  assert.doesNotMatch(inspector, /gridTemplateColumns: `repeat\(\$\{width\}/);
});

test("changing an app action updates the canvas card title", () => {
  assert.match(inspector, /f\.key === "tool"/);
  assert.match(inspector, /title: toolHeadline\(nextTool\.desc\)/);
});

test("the open trigger inspector exposes trigger actions without relying on hover", () => {
  assert.match(editor, /onChangeTrigger=\{changeTrigger\}/);
  assert.match(editor, /onUseWebhook=\{useWebhookTrigger\}/);
  assert.match(inspector, /onChangeTrigger: \(\) => void/);
  assert.match(inspector, /onUseWebhook: \(\) => void/);
  assert.match(inspector, /Change trigger/);
  assert.match(inspector, /Use webhook instead/);
  assert.match(inspector, /This starts your automation/);
});

test("the webhook inspector explains endpoint creation and publication", () => {
  assert.match(inspector, /Custom webhook endpoint/);
  assert.match(inspector, /Create a webhook URL/);
  assert.match(inspector, /Copy endpoint/);
  assert.match(inspector, /Publish these changes/);
});

test("publishing stops when saving the current draft fails", () => {
  assert.match(editor, /if \(dirty && !\(await save\(\)\)\) return/);
});

test("captured webhook samples are scoped to the endpoint token", () => {
  assert.match(inspector, /webhookSampleForSecret/);
  assert.match(inspector, /data\.triggerSample/);
});

test("the canvas toolbar does not confuse arranging modules with Ask AI", () => {
  assert.doesNotMatch(canvas, /Arrange modules|onArrange|arrangeAndFit/);
});

test("the workflow AI drawer stays usable on narrow screens", () => {
  assert.match(editor, /max-md:fixed/);
  assert.match(editor, /max-md:inset-x-3/);
  assert.match(editor, /max-md:top-20/);
  assert.match(editor, /max-md:bottom-3/);
  assert.match(editor, /max-md:sr-only/);
  assert.match(editor, /max-md:w-full max-md:flex-nowrap/);
  assert.match(editor, /max-md:min-w-\[160px\]/);
  assert.match(editor, /max-md:basis-\[160px\]/);
  assert.match(editor, /className="max-md:hidden">\s*<WorkflowLogo/);
  assert.match(chat, /data-ai-chat-empty/);
  assert.match(chat, /min-h-0 flex-1 overflow-y-auto/);
});

test("the workflow AI drawer uses concise, actionable empty-state copy", () => {
  assert.match(chat, />\s*Edit with AI\s*</);
  assert.match(chat, />\s*Try a prompt\s*</);
  assert.match(chat, />Enter<\/kbd> to update/);
  assert.doesNotMatch(chat, /How can I help\?|ZidaneAI AI/);
});

test("the workflow AI chat provides a labelled Start fresh button", () => {
  assert.match(chat, /aria-label="Start fresh"/);
  assert.match(chat, />\s*Start fresh\s*<\/Button>/);
});
