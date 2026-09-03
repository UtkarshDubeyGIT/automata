import { strict as assert } from "node:assert";
import { test } from "node:test";
import { destinationOf } from "@/lib/workflows/destination";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Telling the writer where the words are going.
 *
 * The failure this prevents is not subtle and was entirely invisible from the
 * code: an `ai_step` knew its instruction, its data and the brand, and nothing
 * about the channel — so it wrote the way a language model writes when nobody
 * says otherwise, with a bolded title and markdown headings, and that went
 * out on a real LinkedIn account. The graph knew the destination the whole
 * time; it was two hops away.
 *
 * What matters here is the walk. It has to cross the approval that almost
 * every publishing automation puts in the middle, and it has to REFUSE to
 * guess when a branch means the destination genuinely is not decided yet.
 */

function graph(steps: WorkflowGraph["steps"]): WorkflowGraph {
  return { start: "draft", steps };
}

const post = (platform: string, extra: Record<string, unknown> = {}) => ({
  type: "social_post" as const,
  platform,
  text: "{{steps.draft.result.text}}",
  next: null,
  ...extra,
});

test("a draft published straight to LinkedIn is told so", () => {
  const d = destinationOf(graph({ draft: { type: "ai_step", next: "post" }, post: post("linkedin") }), "draft");
  assert.equal(d?.platform, "linkedin");
  assert.equal(d?.label, "LinkedIn");
  // The two things that actually show up in a published post when they are missing.
  assert.match(d!.brief, /No markdown/i);
  assert.match(d!.brief, /3,000 characters/);
});

test("it crosses the approval that sits in the middle of nearly every one of these", () => {
  const d = destinationOf(
    graph({
      draft: { type: "ai_step", next: "review" },
      review: { type: "human_approval", on_approve: "post", on_reject: null },
      post: post("linkedin"),
    }),
    "draft",
  );
  // Stopping at the approval would leave the most common shape in the product
  // — draft, approve, publish — with no destination at all.
  assert.equal(d?.platform, "linkedin");
});

test("each channel gets its own conventions, not one house style", () => {
  const at = (platform: string) =>
    destinationOf(graph({ draft: { type: "ai_step", next: "post" }, post: post(platform) }), "draft");

  assert.match(at("twitter")!.brief, /280 characters/);
  assert.match(at("instagram")!.brief, /must not describe the media/);
  // Reddit is the one where getting the register wrong is punished hardest.
  assert.match(at("reddit")!.brief, /reads as an advertisement/);
  assert.match(at("slack")!.brief, /no subject line/i);
});

test("the room inside the channel is named, because the manners differ", () => {
  const reddit = destinationOf(
    graph({ draft: { type: "ai_step", next: "post" }, post: post("reddit", { options: { subreddit: "r/SaaS" } }) }),
    "draft",
  );
  assert.equal(reddit?.label, "Reddit (r/SaaS)");

  const slack = destinationOf(
    graph({ draft: { type: "ai_step", next: "post" }, post: post("slack", { options: { channel: "#growth" } }) }),
    "draft",
  );
  assert.equal(slack?.label, "Slack (#growth)");
});

test("a branch in the way means the destination is unknown, and it says nothing", () => {
  const d = destinationOf(
    graph({
      draft: { type: "ai_step", next: "route" },
      route: { type: "branch", branch_on: "category", cases: { good: "post" }, default: null },
      post: post("linkedin"),
    }),
    "draft",
  );
  // Which way the run goes is decided by data this very step is about to
  // produce. A confident wrong answer here is worse than no answer.
  assert.equal(d, null);
});

test("a draft nothing publishes gets no channel conventions imposed on it", () => {
  const d = destinationOf(
    graph({
      draft: { type: "ai_step", next: "note" },
      note: { type: "log_action", label: "note", message: "x", next: null },
    }),
    "draft",
  );
  assert.equal(d, null);
});
