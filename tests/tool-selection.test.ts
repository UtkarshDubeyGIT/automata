import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import type { ToolSpec } from "@/lib/workflows/registry";

/**
 * Stage 2 and 3 of tool selection: narrow the retrieved integrations, expand
 * the chosen few, and render them.
 *
 * The properties pinned here are the ones whose failure is silent. An
 * oversized expansion just costs tokens and nobody notices; an EMPTY catalog
 * fails every build with a confusing "invented tool slug" error; and a
 * dropped keepSlug breaks editing in a way that only shows up on workflows
 * that already exist.
 */

/** A toolkit big enough to exercise the per-integration cap (60). */
function bigToolkit(app: string, n: number): Array<{ slug: string; spec: ToolSpec }> {
  return Array.from({ length: n }, (_, i) => ({
    slug: `${app.toUpperCase()}_ACTION_${i}`,
    spec: {
      app,
      kind: "write" as const,
      external: true,
      required: [],
      desc: `Action number ${i}`,
      argHint: "{}",
    },
  }));
}

let listed: string[] = [];
let toolkitResponse: (app: string) => Array<{ slug: string; spec: ToolSpec }> = () => [];
let narrowReply = '{"apps":["slack"]}';
let retrievalResult = {
  ranked: ["slack"],
  forced: [] as string[],
  selected: ["slack"],
  mode: "hybrid" as const,
  degraded: false,
};

mock.module("@/lib/workflows/retrieval", {
  namedExports: { retrieveIntegrations: async () => retrievalResult },
});

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async () => narrowReply,
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    listToolsForToolkit: async (app: string) => {
      listed.push(app);
      return toolkitResponse(app);
    },
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => ({
      from: () => ({
        select: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }),
      }),
    }),
  },
});

function reset() {
  listed = [];
  narrowReply = '{"apps":["slack"]}';
  retrievalResult = { ranked: ["slack"], forced: [], selected: ["slack"], mode: "hybrid", degraded: false };
}

test("an oversized toolkit is capped rather than rendered whole", async () => {
  reset();
  toolkitResponse = (app) => bigToolkit(app, 300);
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  const result = await selectTools("post a message to the team");
  const lines = result.text.split("\n").filter(Boolean);
  assert.ok(
    lines.length <= 60,
    `a 300-tool toolkit rendered ${lines.length} lines — the cap is not holding`,
  );
  assert.ok(lines.length > 0);
});

test("a pinned slug survives the cap", async () => {
  reset();
  toolkitResponse = (app) => bigToolkit(app, 300);
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  // Deliberately the LAST tool, so relevance ranking would never reach it.
  const pinned = "SLACK_ACTION_299";
  const result = await selectTools("post a message to the team", { keepSlugs: [pinned] });
  assert.ok(
    result.text.includes(pinned),
    "the tool belonging to the step being edited was dropped by the cap",
  );
});

test("an app the caller pinned is expanded even when narrowing ignores it", async () => {
  reset();
  // The model picks only slack; the graph being edited also uses github.
  narrowReply = '{"apps":["slack"]}';
  retrievalResult = { ranked: ["slack"], forced: ["github"], selected: ["slack", "github"], mode: "hybrid", degraded: false };
  toolkitResponse = (app) => bigToolkit(app, 5);
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  const result = await selectTools("add a Slack message after this", { keepApps: ["github"] });
  assert.ok(result.integrations.includes("github"), "a pinned app must not be narrowed away");
  assert.ok(listed.includes("github"), "the pinned app's tools were never fetched");
});

test("an unusable narrowing reply falls back to the ranking instead of failing", async () => {
  reset();
  narrowReply = "not json at all";
  toolkitResponse = (app) => bigToolkit(app, 3);
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  const result = await selectTools("post a message to the team");
  assert.ok(result.text.length > 0, "a failed narrowing produced an empty catalog");
  assert.equal(result.degraded, true, "a fallback must be reported as degraded");
});

test("a model-invented app slug is ignored", async () => {
  reset();
  // Nothing should send us fetching a toolkit that was never on offer.
  narrowReply = '{"apps":["definitely_not_a_real_toolkit"]}';
  toolkitResponse = (app) => bigToolkit(app, 3);
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  await selectTools("post a message to the team");
  assert.ok(
    !listed.includes("definitely_not_a_real_toolkit"),
    "an invented slug reached Composio",
  );
});

test("the catalog is never empty, even when every toolkit fetch comes back empty", async () => {
  reset();
  toolkitResponse = () => [];
  const { selectTools } = await import("@/lib/workflows/tool-selection");

  const result = await selectTools("post a message to the team");
  // An empty AVAILABLE APP ACTIONS block is not a degraded build, it is a
  // guaranteed failed one — the model has nothing to emit and invents a slug.
  assert.ok(result.text.length > 0, "selection produced an empty catalog");
  assert.equal(result.degraded, true);
});
