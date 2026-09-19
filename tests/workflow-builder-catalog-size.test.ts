import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * `toolsForPrompt` used to dump the whole 999-entry registry (~292KB, 893 of
 * them GitHub) into the system prompt on every build call. These tests drive
 * `buildWorkflow` end to end and inspect the actual system prompt `chat()`
 * received, so a regression that widens the GitHub filter back out shows up
 * here rather than only in a registry-level unit test.
 */

let lastSystemPrompt = "";

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
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

test("a non-GitHub request keeps the system prompt far below the full unfiltered catalog", async () => {
  const { buildWorkflow } = await import("@/lib/workflows/builder");
  await buildWorkflow("Every morning at 9am post a summary to our Slack channel");

  assert.ok(lastSystemPrompt.length > 0, "chat() was never called");
  // The unfiltered tools catalog alone used to be ~292KB; a Slack-only ask
  // should land far below that once GitHub is filtered to relevance.
  assert.ok(
    lastSystemPrompt.length < 150_000,
    `expected a filtered system prompt, got ${lastSystemPrompt.length} chars`,
  );
});

test("a GitHub-flavored request surfaces a larger, more GitHub-specific catalog", async () => {
  const { buildWorkflow } = await import("@/lib/workflows/builder");

  await buildWorkflow("Every morning at 9am post a summary to our Slack channel");
  const slackOnlyLength = lastSystemPrompt.length;

  await buildWorkflow(
    "When a new issue is opened on our GitHub repo, comment on it and merge related pull requests",
  );
  const githubHeavyLength = lastSystemPrompt.length;

  assert.ok(
    githubHeavyLength > slackOnlyLength,
    `expected the GitHub-flavored request (${githubHeavyLength} chars) to show more catalog than the Slack-only one (${slackOnlyLength} chars)`,
  );
  assert.ok(lastSystemPrompt.includes("GITHUB_CREATE_A_PULL_REQUEST"));
});
