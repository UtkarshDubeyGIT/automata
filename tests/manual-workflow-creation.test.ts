import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { palette } from "@/lib/workflows/blocks";
import { replaceTrigger } from "@/lib/workflows/edit";
import { TEMPLATES } from "@/lib/workflows/templates";

test("the manual creation path starts from one valid manual trigger", () => {
  const manual = TEMPLATES.find((template) => template.id === "blank");

  assert.ok(manual);
  assert.equal(manual.graph.start, "start");
  assert.deepEqual(Object.keys(manual.graph.steps), ["start"]);
  assert.equal(manual.graph.steps.start.type, "manual_trigger_input");
});

test("the Automations tab offers the blank workflow as Add manually", () => {
  const page = readFileSync("src/app/(app)/workflows/page.tsx", "utf8");
  const editor = readFileSync("src/app/(app)/workflows/[id]/page.tsx", "utf8");

  assert.match(page, /const MANUAL_TEMPLATE = TEMPLATES\.find/);
  assert.match(page, /startTemplate\(MANUAL_TEMPLATE, true\)/);
  assert.match(page, /\?creating=1&chat=1/);
  assert.match(editor, /useState\(searchParams\.get\("chat"\) === "1"\)/);
  assert.match(page, />\s*Add manually\s*<\/Button>/);
});

test("the creation screen offers one natural manual alternative before templates", () => {
  const page = readFileSync("src/app/(app)/workflows/page.tsx", "utf8");

  assert.match(page, /data-create-manually/);
  assert.match(page, /Prefer to build step by step\?/);
  assert.match(page, />\s*Create manually\s*<\/Button>/);
  assert.match(page, /TEMPLATES\.filter\(\(template\) => template\.id !== MANUAL_TEMPLATE\.id\)/);
});

test("the manual trigger can switch directly to an incoming webhook", () => {
  const manual = TEMPLATES.find((template) => template.id === "blank");
  const webhook = palette().find((block) => block.id === "trigger:webhook");
  assert.ok(manual);
  assert.ok(webhook);

  const result = replaceTrigger(manual.graph, webhook);

  assert.equal(result.graph.steps[result.graph.start].type, "webhook_trigger");
  assert.ok(result.graph.steps[result.graph.start].secret);
});
