import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The builder must be shown the SELECTED tool catalog and nothing else.
 *
 * Before retrieval existed, `toolsForPrompt()` dumped the whole curated
 * registry — 999 entries, ~292KB, 893 of them GitHub — into the system prompt
 * on every build, edit and repair call. The fix only holds if `buildWorkflow`
 * actually renders what `selectTools` returned rather than falling back to
 * the full registry, so this drives the builder end to end and inspects the
 * prompt `chat()` really received.
 */

let lastSystemPrompt = "";

const SELECTED_CATALOG = [
  "  - SLACK_SEND_MESSAGE (slack, WRITE [external/visible]): Post a message — args: {\"channel\":\"\"}",
  "  - SLACK_FIND_CHANNELS (slack, READ): Find channels — args: {\"query\":\"\"}",
].join("\n");

mock.module("@/lib/workflows/tool-selection", {
  namedExports: {
    selectTools: async () => ({
      text: SELECTED_CATALOG,
      integrations: ["slack"],
      specs: {},
      degraded: false,
    }),
  },
});

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    embed: async (texts: string[]) => texts.map(() => new Array(256).fill(0)),
    chat: async (messages: { role: string; content: string }[]) => {
      lastSystemPrompt = String(messages[0]?.content ?? "");
      return JSON.stringify({
        title: "Daily Slack Summary",
        description: "Posts a daily summary to Slack",
        start: "start",
        steps: {
          start: { type: "manual_trigger_input", title: "Manual Start", next: "post" },
          post: {
            type: "social_post",
            title: "Post to Slack",
            platform: "slack",
            text: "Daily summary",
            options: { channel: "#general" },
            next: null,
          },
        },
      });
    },
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    findToolSpec: async () => null,
    PLATFORMS: [{ id: "slack", name: "Slack", description: "Team messaging" }],
  },
});

test("the system prompt carries the selected catalog, not the whole registry", async () => {
  const { buildWorkflow } = await import("@/lib/workflows/builder");
  await buildWorkflow("Every morning at 9am post a summary to our Slack channel");

  assert.ok(lastSystemPrompt.length > 0, "chat() was never called");
  assert.ok(
    lastSystemPrompt.includes("SLACK_SEND_MESSAGE"),
    "the selected catalog is missing from the prompt",
  );
  // The unfiltered registry alone was ~292KB. Anything near that means the
  // builder stopped using the selection and went back to dumping TOOLS.
  assert.ok(
    lastSystemPrompt.length < 100_000,
    `expected a selected catalog, got a ${lastSystemPrompt.length}-char prompt`,
  );
  // GitHub is 893 of the 999 curated entries and has nothing to do with this
  // request — its presence is the specific regression being guarded.
  assert.ok(
    !lastSystemPrompt.includes("GITHUB_CREATE_AN_ISSUE"),
    "unrelated GitHub actions leaked into a Slack-only request",
  );
});
