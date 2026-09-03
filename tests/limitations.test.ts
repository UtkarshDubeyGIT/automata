import { strict as assert } from "node:assert";
import { test } from "node:test";
import { limitations } from "@/lib/workflows/limitations";
import { TRIGGERS } from "@/lib/workflows/registry";
import { validateGraph, setupGaps } from "@/lib/workflows/validate";
import type { StepDef, WorkflowGraph } from "@/lib/workflows/types";

/**
 * The small print an automation used to keep to itself.
 *
 * Every case here is a graph that VALIDATES and has NO setup gaps — that is
 * the point. The editor already had two ways to speak (this can't be saved,
 * this field is blank) and neither of them can say "this is fine and it still
 * won't do what you think", so nothing did.
 */

function graphOf(steps: WorkflowGraph["steps"], start: string): WorkflowGraph {
  return { start, steps } as WorkflowGraph;
}

/** These are claims about WORKING automations, so prove they are working. */
function assertClean(graph: WorkflowGraph): void {
  validateGraph(graph);
  assert.deepEqual(setupGaps(graph), {}, "fixture should have no setup gaps");
}

test("a trigger that asks for a push does not pre-announce the fallback", () => {
  /*
   * Shopify publishes no trigger types at all today (verified against the live
   * v3 catalog), so this one will in fact poll — but that is a fact about
   * Composio's catalog on the day it is asked, not about the graph, which is
   * why the registry keeps its preference list and asks anyway.
   *
   * This panel used to answer that with "we will ask, and here is how late it
   * could be if the answer is no". A caveat on every app-event automation ever
   * built, for a fallback most of them never take, and quoting a cadence the
   * editor no longer even offers to set. The honest moment to say it is AFTER
   * the enable path has an answer — which the reason test below covers.
   */
  const graph = graphOf(
    {
      order: {
        type: "app_event_trigger",
        event: "NEW_SHOPIFY_ORDER",
        interval_minutes: 60,
        next: "log",
      },
      log: { type: "log_action", message: "new order", next: null },
    },
    "order",
  );
  assertClean(graph);

  assert.deepEqual(limitations(graph).filter((l) => l.kind === "delivery"), []);
});

test("a trigger reachable without extra setup does not demand it", () => {
  /*
   * Linear used to be told "fill in Team or this only gets checked hourly",
   * which was true of the trigger type we resolved first
   * (LINEAR_ISSUE_CREATED_TRIGGER requires team_id) and false of the toolkit:
   * LINEAR_PUBLIC_TEAM_ISSUE_CREATED pushes the same event with team_id
   * optional. `enable()` now walks the preference list and takes the first
   * candidate whose config it can satisfy, so a blank Team still gets real
   * time for public teams — and this panel must not claim otherwise.
   */
  const withoutTeam = graphOf(
    {
      issue: { type: "app_event_trigger", event: "NEW_LINEAR_ISSUE", interval_minutes: 60, next: "log" },
      log: { type: "log_action", message: "new issue", next: null },
    },
    "issue",
  );
  assertClean(withoutTeam);

  const delivery = limitations(withoutTeam).filter((l) => l.kind === "delivery");
  assert.equal(
    delivery.filter((l) => /team/i.test(l.title) || /team/i.test(l.detail)).length,
    0,
    "a blank Team no longer costs real time, so it must not be presented as if it does",
  );
  // And with nothing left to demand there is nothing to say at all: a trigger
  // whose real-time requirements are already met gets a clean panel.
  assert.deepEqual(delivery, []);

  // The registry is what encodes that: a `needs` entry means real time is
  // UNREACHABLE without it, and Linear no longer qualifies.
  assert.deepEqual(TRIGGERS.NEW_LINEAR_ISSUE.realtime?.needs ?? [], []);
  // GitHub genuinely does require both, and both are fields the user must fill
  // in anyway, so nothing regressed for the case `needs` exists to describe.
  assert.deepEqual(TRIGGERS.NEW_GITHUB_ISSUE.realtime?.needs, ["owner", "repo"]);
});

test("the reason real time was refused is what gets shown, once it is known", () => {
  const graph = graphOf(
    {
      issue: {
        type: "app_event_trigger",
        event: "NEW_GITHUB_ISSUE",
        watch_owner: "vercel",
        watch_repo: "next.js",
        interval_minutes: 60,
        next: "log",
      },
      log: { type: "log_action", message: "new issue", next: null },
    },
    "issue",
  );
  assertClean(graph);

  // Switched on and pushing: there is nothing to warn about.
  assert.deepEqual(limitations(graph, { mode: "realtime" }), []);

  // Switched on and polling: the enable path's own explanation wins over
  // anything this module could infer, because it is what actually happened.
  const [limit] = limitations(graph, {
    mode: "poll",
    reason: "Set COMPOSIO_WEBHOOK_SECRET to receive events the moment they happen.",
  });
  assert.equal(limit.detail, "Set COMPOSIO_WEBHOOK_SECRET to receive events the moment they happen.");
});

test("an app with no live connection says so once, not once per step", () => {
  // Google Business Profile has no Composio toolkit: the sweep never fires it
  // and every call against it is simulated. A green "Run complete" on this
  // graph means a reply was drafted and nothing was ever posted.
  const graph = graphOf(
    {
      review: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "reply" },
      reply: {
        type: "app_action",
        tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
        title: "Post the reply",
        arguments: { review_id: "{{steps.review.event.review_id}}", reply: "Thank you!" },
        next: null,
      },
    },
    "review",
  );
  assertClean(graph);

  const simulated = limitations(graph).filter((l) => l.kind === "simulated");
  assert.equal(simulated.length, 1, "one missing connection is one thing to say");
  assert.equal(simulated[0].stepId, "review", "anchored where it fails to start");
  assert.match(simulated[0].detail, /never starts by itself/);
  assert.match(simulated[0].detail, /“Post the reply”/);
  // Simulated sorts first: whether anything reaches the app at all outranks
  // how quickly it gets there.
  assert.equal(limitations(graph)[0].kind, "simulated");
});

test("branches that all do the same thing are counted, not repeated", () => {
  /*
   * The shipped review-reply template, and what the panel used to look like on
   * it: one line for the trigger and three byte-identical lines for the three
   * sentiment branches — same title, same sentence, same app — because the
   * branches share a name. Four paragraphs, one fact.
   */
  // Annotated, or TS widens `type` to string and the literal stops being a StepDef.
  const reply = (id: string): StepDef => ({
    type: "app_action",
    tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
    title: "Post the reply",
    arguments: { review_id: `{{steps.review.event.review_id}}`, reply: `Thanks (${id})` },
    next: null,
  });
  const graph = graphOf(
    {
      review: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "sort" },
      sort: {
        type: "branch",
        from_step: "review",
        key: "event.rating",
        cases: { "5": "good", "3": "ok" },
        default: "bad",
      },
      good: reply("good"),
      ok: reply("ok"),
      bad: reply("bad"),
    },
    "review",
  );
  assertClean(graph);

  const lines = limitations(graph);
  assert.equal(lines.length, 1, "one connection, one line");
  assert.match(lines[0].detail, /3 steps/, "the count is what three identical titles add up to");
  assert.equal(
    lines.filter((l) => l.detail === lines[0].detail).length,
    1,
    "nothing in the panel may say the same sentence twice",
  );
});

test("a WhatsApp template wired to an AI step is told the wording is fixed", () => {
  /*
   * The natural way to build "message the customer about their order", and it
   * validates perfectly: the reference resolves, the field exists, the step is
   * fully configured. WhatsApp then sends the approved template wording and
   * drops the draft — so the automation reports success having sent something
   * nobody wrote.
   */
  const graph = graphOf(
    {
      order: { type: "app_event_trigger", event: "NEW_SHOPIFY_ORDER", next: "draft" },
      draft: {
        type: "ai_step",
        title: "Write the thank-you",
        instruction: "Thank {{steps.order.event.customer}} for their order.",
        next: "send",
      },
      send: {
        type: "app_action",
        tool: "WHATSAPP_SEND_TEMPLATE_MESSAGE",
        title: "WhatsApp the customer",
        arguments: {
          phone_number_id: "1234567890",
          to_number: "919876543210",
          template_name: "order_received",
          body_1: "{{steps.draft.text}}",
        },
        next: null,
      },
    },
    "order",
  );
  assertClean(graph);

  const found = limitations(graph).filter((l) => l.title.includes("Write the thank-you"));
  assert.equal(found.length, 1, "the AI step it silently discards must be named");
  assert.match(found[0].detail, /approved in WhatsApp Manager/);

  // The same tool with its own wording is a documented constraint, not a
  // contradiction, so it does not raise this one.
  const noAi = graphOf(
    {
      ...graph.steps,
      send: {
        ...graph.steps.send,
        arguments: { ...(graph.steps.send.arguments as object), body_1: "Thanks for your order!" },
      },
      draft: { ...graph.steps.draft, next: "send" },
    },
    "order",
  );
  assert.equal(
    limitations(noAi).filter((l) => l.title.includes("Write the thank-you")).length,
    0,
  );
});

test("a step leaning on a setting made elsewhere says which setting", () => {
  // object_id is required by Meta and autofilled from the workspace's saved ad
  // account, which is why it is not a setup gap. A workspace that never saved
  // one gets a step that looks complete and fails on its first run.
  const graph = graphOf(
    {
      daily: { type: "schedule_trigger", cadence: "daily", time: "09:00", next: "read" },
      read: {
        type: "app_action",
        tool: "METAADS_GET_INSIGHTS",
        title: "Yesterday's spend",
        arguments: { object_id: "", date_preset: "yesterday" },
        next: null,
      },
    },
    "daily",
  );
  assertClean(graph);

  const [limit] = limitations(graph).filter((l) => l.stepId === "read");
  assert.match(limit.detail, /Settings → Paid channels/);

  // Point it at a specific account and the dependency is gone.
  const explicit = graphOf(
    { ...graph.steps, read: { ...graph.steps.read, arguments: { object_id: "act_123", date_preset: "yesterday" } } },
    "daily",
  );
  assert.deepEqual(limitations(explicit), []);
});

test("an automation with nothing to disclose discloses nothing", () => {
  // The list has to be able to be empty, or it becomes noise people scroll past.
  const graph = graphOf(
    {
      daily: { type: "schedule_trigger", cadence: "daily", time: "09:00", next: "draft" },
      draft: { type: "ai_step", instruction: "Write a short update.", next: null },
    },
    "daily",
  );
  assertClean(graph);
  assert.deepEqual(limitations(graph), []);
});

test("an image step says it spends credits on every run, not once", () => {
  /*
   * The graph is complete and correct — this is exactly the case the panel
   * exists for. On a manual workflow the spend is obvious because you pressed
   * the button; on an hourly schedule it is not, and the balance is where you
   * find out.
   */
  const graph = graphOf(
    {
      daily: { type: "schedule_trigger", cadence: "daily", hour: 9, next: "pic" },
      pic: {
        type: "generate_image",
        title: "Draw the product",
        prompt: "the product on a clean desk",
        aspect: "square",
        next: null,
      },
    },
    "daily",
  );
  assertClean(graph);
  const found = limitations(graph).find((l) => l.stepId === "pic");
  assert.ok(found, "an image step must declare its running cost");
  assert.match(found.title, /costs credits on every run/);
});

test("a blank image step is a setup gap, and a described one is not", () => {
  const steps = (prompt: string): WorkflowGraph["steps"] => ({
    go: { type: "manual_trigger_input", next: "pic" },
    pic: { type: "generate_image", prompt, next: null } as StepDef,
  });
  assert.deepEqual(setupGaps(graphOf(steps("the product on a desk"), "go")), {});
  assert.deepEqual(setupGaps(graphOf(steps("  "), "go")), {
    pic: ["Describe the image to generate"],
  });
});

test("an Instagram post can point at an image the graph itself makes", () => {
  /*
   * Before `generate_image` existed this was unbuildable: validation asked for
   * a media URL and nothing in the product could produce one, so the only fix
   * was to paste a link from somewhere else entirely.
   */
  const graph = graphOf(
    {
      go: { type: "manual_trigger_input", next: "pic" },
      pic: { type: "generate_image", prompt: "the product", next: "post" },
      post: {
        type: "social_post",
        platform: "instagram",
        text: "new drop",
        mediaUrl: "{{steps.pic.url}}",
        next: null,
      },
    },
    "go",
  );
  // Would throw on an unresolvable reference — `.url` must be a field the
  // image step actually declares, or this is a graph that dies on first run.
  assertClean(graph);
});
