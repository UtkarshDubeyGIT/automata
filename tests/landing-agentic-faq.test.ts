import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const landing = readFileSync("src/components/landing-space/space-landing.tsx", "utf8");

test("the landing FAQ explains the agentic work Automata can take on", () => {
  assert.match(landing, /What can I delegate to an AI agent\?/);
  assert.match(landing, /How is this different from a standard automation\?/);
  assert.match(landing, /research, summarize, and draft/i);
  assert.match(landing, /live context from connected tools/i);
});

test("the landing FAQ presents agent autonomy as bounded and reviewable", () => {
  assert.match(landing, /You decide what it can handle/i);
  assert.match(landing, /approval/i);
  assert.match(landing, /What to delegate, how the agent gets context, and where you stay in control/i);
});

test("the landing frames Automata as an outcome-first AI builder", () => {
  assert.match(landing, /Describe the outcome\./);
  assert.match(landing, /Automata builds the work\./);
  assert.match(landing, /Automata is an AI workflow automation builder for solo operators, developers, and small teams/);
  assert.match(landing, /See how the AI builder works/);
  assert.match(landing, /href="#how"/);
  assert.doesNotMatch(landing, /href="\/app\/workflows\/daily-pipeline-digest"/);
  assert.match(landing, /Let Automata handle recurring work <em>across your tools\.<\/em>/);
  assert.match(landing, /Automata chooses the trigger, connected tools, AI steps, and approvals/);
  assert.match(landing, /Give agents context\. <em>Set their limits\.<\/em>/);
  assert.match(landing, /Stop building workflows\./);
  assert.match(landing, /Describe a job and its outcome in plain language/);
  assert.match(landing, /Define the outcome\. Automata builds a trusted path to it\./);
});

test("the landing avoids presenting manual workflow construction as the main job", () => {
  assert.doesNotMatch(landing, /Build your first routine/);
  assert.doesNotMatch(landing, /Steal our best <em>workflows\.<\/em>/);
  assert.doesNotMatch(landing, /Three steps\. <em>Then it just runs\.<\/em>/);
});
