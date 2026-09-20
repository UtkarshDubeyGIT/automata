import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const landing = readFileSync("src/components/landing-space/space-landing.tsx", "utf8");

test("the landing FAQ explains the agentic work Automata can take on", () => {
  assert.match(landing, /What can I delegate to an AI agent\?/);
  assert.match(landing, /How is this different from a standard automation\?/);
  assert.match(landing, /research, synthesize, and draft/i);
  assert.match(landing, /live context from your connected tools/i);
});

test("the landing FAQ presents agent autonomy as bounded and reviewable", () => {
  assert.match(landing, /your boundaries/i);
  assert.match(landing, /approval/i);
  assert.match(landing, /What to delegate, how the agent gets context, and where you stay in control/i);
});

test("the landing frames Automata as an outcome-first AI builder", () => {
  assert.match(landing, /Describe the outcome\./);
  assert.match(landing, /Automata builds the work\./);
  assert.match(landing, /The workflow should be <em>the easy part\.<\/em>/);
  assert.match(landing, /Automata selects the trigger, connected tools, AI work, and approvals/);
  assert.match(landing, /Give agents context\. <em>Keep the call\.<\/em>/);
  assert.match(landing, /Stop building workflows\./);
  assert.match(landing, /Start by describing a job and outcome in plain language/);
  assert.match(landing, /Define the outcome\. Automata builds a trusted path to it\./);
});

test("the landing avoids presenting manual workflow construction as the main job", () => {
  assert.doesNotMatch(landing, /Build your first routine/);
  assert.doesNotMatch(landing, /Steal our best <em>workflows\.<\/em>/);
  assert.doesNotMatch(landing, /Three steps\. <em>Then it just runs\.<\/em>/);
});
