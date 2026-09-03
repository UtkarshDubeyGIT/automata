import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clampOutput, route } from "@/lib/workflows/engine";
import { findCycle } from "@/lib/workflows/graph";
import { repairRefs, stripPlaceholders } from "@/lib/workflows/repair";
import { BuildError, gapCount, missingSetup, setupGaps, validateGraph } from "@/lib/workflows/validate";
import { TEMPLATES } from "@/lib/workflows/templates";
import type { WorkflowGraph } from "@/lib/workflows/types";

/** Structural rules the engine and the editor both depend on. */

test("a cycle is rejected at build time, not discovered mid-run", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { type: "manual_trigger_input", next: "draft" },
      draft: { type: "ai_step", instruction: "write", next: "check" },
      check: {
        type: "branch",
        from_step: "draft",
        key: "verdict",
        branch_on: "verdict",
        cases: { again: "draft", done: null },
        default: null,
      },
    },
  };
  // hasTerminal passes here — the "done" case ends — which is exactly why a
  // cyclic branch used to validate clean and only failed after up to 50 real
  // steps had already run.
  const cycle = findCycle(graph);
  assert.deepEqual(cycle, ["draft", "check", "draft"]);
  assert.throws(() => validateGraph(graph), BuildError);
});

test("an acyclic graph reports no cycle", () => {
  assert.equal(
    findCycle({
      start: "a",
      steps: {
        a: { type: "manual_trigger_input", next: "b" },
        b: { type: "log_action", next: null },
      },
    }),
    null,
  );
});

test("every shipped template still validates", () => {
  for (const template of TEMPLATES) {
    assert.doesNotThrow(() => validateGraph(template.graph), `template '${template.id}'`);
  }
});

test("repairRefs is a fixed point", () => {
  // The root cause of the dirty-forever bug: the client stores the graph the
  // server repaired, so if repairing it AGAIN changed anything the editor
  // would report unsaved changes it could never clear.
  for (const template of TEMPLATES) {
    const once = repairRefs(template.graph).graph;
    const twice = repairRefs(once);
    assert.equal(twice.fixes.length, 0, `template '${template.id}' kept changing`);
    assert.deepEqual(twice.graph, once, `template '${template.id}' is not stable`);
  }
});

test("repairRefs converges on a graph that genuinely needs fixing", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: { type: "manual_trigger_input", next: "draft" },
      // A TEXT ai_step emits `.text`, never `.result` — the classic near-miss.
      draft: { type: "ai_step", instruction: "write a post", next: "note" },
      note: { type: "log_action", message: "{{steps.draft.result}}", next: null },
    },
  };
  const first = repairRefs(graph);
  assert.equal(first.fixes.length, 1);
  assert.equal(first.graph.steps.note.message, "{{steps.draft.text}}");
  assert.equal(repairRefs(first.graph).fixes.length, 0);
});

// ---------------------------------------------------------------------------
// route()
// ---------------------------------------------------------------------------

test("a step carrying on_reject: null still follows its next", () => {
  // Key PRESENCE used to mean "this is an approval", so a step declaring a
  // real `next` alongside a null on_reject routed to null and ended the run.
  const step = { type: "log_action" as const, next: "after", on_reject: null };
  assert.equal(route(step, {}), "after");
});

test("a genuinely wired approve/reject edge is still honoured", () => {
  const step = { type: "human_approval" as const, on_approve: "post", on_reject: "stop" };
  assert.equal(route(step, { decision: "approve" }), "post");
  assert.equal(route(step, { decision: "reject" }), "stop");
});

test("branch and filter agree on the same value", () => {
  const branch = {
    type: "branch" as const,
    branch_on: "sentiment",
    cases: { positive: "thanks", negative: "apologize" },
    default: "ignore",
  };
  // A model answering "Positive" used to fall through to `default`, while the
  // equivalent filter matched — the same data, two answers.
  assert.equal(route(branch, { sentiment: "Positive" }), "thanks");
  assert.equal(route(branch, { sentiment: " negative " }), "apologize");
  assert.equal(route(branch, { sentiment: "confused" }), "ignore");
  assert.equal(route(branch, {}), "ignore");
});

test("branch reads a json ai_step's nested result", () => {
  const branch = {
    type: "branch" as const,
    branch_on: "kind",
    cases: { urgent: "page" },
    default: "queue",
  };
  assert.equal(route(branch, { result: { kind: "urgent" } }), "page");
});

// ---------------------------------------------------------------------------
// Output clamping
// ---------------------------------------------------------------------------

test("clamping keeps every key, including a nested result", () => {
  const output = {
    result: { verdict: "positive", reply: "x".repeat(30_000), score: 4 },
    provider: "openai",
    sim: true,
  };
  const clamped = clampOutput(output);
  // The old clamp rebuilt a flat object of scalars, so `result` vanished
  // entirely and branch_on silently fell through to `default`.
  assert.equal(clamped.truncated, true);
  const result = clamped.result as Record<string, unknown>;
  assert.equal(result.verdict, "positive");
  assert.equal(result.score, 4);
  assert.equal((result.reply as string).length, 4000);
  assert.equal(clamped.sim, true);
});

test("a small output is returned untouched", () => {
  const output = { text: "hello", result: { a: 1 } };
  assert.equal(clampOutput(output), output);
});

// ---------------------------------------------------------------------------
// Stand-in values
// ---------------------------------------------------------------------------

test("a trigger target the builder invented counts as unset", () => {
  // Exactly what shipped: `<owner>/<repo>` is not blank, so every guard passed
  // it through and the automation went live polling GitHub hourly for a
  // repository called `<repo>`.
  const missing = missingSetup({
    type: "app_event_trigger",
    event: "NEW_GITHUB_ISSUE",
    watch_owner: "<owner>",
    watch_repo: "<repo>",
    next: null,
  });
  assert.deepEqual(missing, ["Fill in “Repository owner”", "Fill in “Repository”"]);
});

test("a real trigger target needs no setup", () => {
  const missing = missingSetup({
    type: "app_event_trigger",
    event: "NEW_GITHUB_ISSUE",
    watch_owner: "vercel",
    watch_repo: "next.js",
    next: null,
  });
  assert.deepEqual(missing, []);
});

test("an action argument copied out of the catalog counts as unset", () => {
  // The same hole one step along: `a@b.com` passed validation and mailed a
  // stranger on a charged run.
  const missing = missingSetup({
    type: "app_action",
    tool: "GMAIL_SEND_EMAIL",
    arguments: {
      recipient_email: "a@b.com",
      subject: "{{steps.draft.result.subject}}",
      body: "{{steps.draft.result.body}}",
    },
    next: null,
  });
  assert.deepEqual(missing, ["Fill in “recipient_email”"]);
});

test("stripPlaceholders blanks a stand-in and leaves everything else alone", () => {
  const graph: WorkflowGraph = {
    start: "trigger",
    steps: {
      trigger: {
        type: "app_event_trigger",
        event: "NEW_GITHUB_ISSUE",
        watch_owner: "<owner>",
        watch_repo: "vercel",
        next: "mail",
      },
      mail: {
        type: "app_action",
        tool: "GMAIL_SEND_EMAIL",
        arguments: {
          recipient_email: "a@b.com",
          subject: "New issue",
          // An AI-drafted body may legitimately contain angle brackets. Only a
          // WHOLE value that is nothing but a stand-in is refused.
          body: "Fix the <b>bold</b> rendering",
        },
        next: null,
      },
    },
  };

  const { graph: clean, blanked } = stripPlaceholders(graph);
  assert.equal(clean.steps.trigger.watch_owner, "");
  assert.equal(clean.steps.trigger.watch_repo, "vercel");
  const args = clean.steps.mail.arguments as Record<string, unknown>;
  assert.equal(args.recipient_email, "");
  assert.equal(args.body, "Fix the <b>bold</b> rendering");
  assert.deepEqual(blanked.sort(), ["mail.arguments.recipient_email", "trigger.watch_owner"]);

  // The input is untouched, and a second pass changes nothing.
  assert.equal(graph.steps.trigger.watch_owner, "<owner>");
  assert.deepEqual(stripPlaceholders(clean).blanked, []);

  // And what it produces is what the editor already knows how to explain.
  assert.deepEqual(setupGaps(clean), {
    trigger: ["Fill in “Repository owner”"],
    mail: ["Fill in “recipient_email”"],
  });
});

test("setup gaps are counted in steps, not in complaints", () => {
  // One GitHub trigger missing owner AND repo is ONE card to go and fix. Both
  // the enable-toggle 409 and the Test toast used to say "2 steps".
  const gaps = setupGaps({
    start: "trigger",
    steps: {
      trigger: {
        type: "app_event_trigger",
        event: "NEW_GITHUB_ISSUE",
        watch_owner: "<owner>",
        watch_repo: "<repo>",
        next: null,
      },
    },
  } as unknown as WorkflowGraph);
  assert.equal(Object.values(gaps).flat().length, 2);
  assert.equal(gapCount(gaps), 1);
});
