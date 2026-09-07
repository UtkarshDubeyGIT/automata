import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

const aiPrompts: { role: string; content: string }[][] = [];
// An array, not a reassigned `let`: a variable written only inside the mock
// below stays narrowed to its initial `null` at the assertion site.
const posts: Record<string, unknown>[] = [];

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async (messages: { role: string; content: string }[]) => {
      aiPrompts.push(messages);
      return "*Action items*\n• Priya owns the release notes by Friday.";
    },
    explainAiError: (err: unknown) => String(err),
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => null,
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    socialProvider: {
      live: true,
      post: async (input: Record<string, unknown>) => {
        posts.push(input);
        return { ok: true, externalId: "slack-1" };
      },
      listConnections: async () => [{ platform: "slack", status: "connected" }],
    },
    executeTool: async () => ({ successful: true, data: {} }),
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");

function context(transcript: string) {
  return {
    input: { transcript },
    steps: { webhook: { body: {} } },
  };
}

test("a generic AI step receives the raw webhook payload", async () => {
  aiPrompts.length = 0;
  await HANDLERS.ai_step({
    runId: "run-ai",
    stepId: "draft",
    step: { type: "ai_step", instruction: "Summarize the meeting and list action items." },
    data: context("Alex owns the launch checklist and will finish it by Friday."),
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.match(
    aiPrompts.at(-1)?.at(-1)?.content ?? "",
    /Alex owns the launch checklist and will finish it by Friday\./,
  );
});

test("a Slack AI instruction receives webhook data before posting", async () => {
  aiPrompts.length = 0;
  posts.length = 0;
  const result = await HANDLERS.social_post({
    runId: "run-slack",
    stepId: "send",
    step: {
      type: "social_post",
      platform: "slack",
      instruction: "Summarize the incoming meeting transcript and list action items.",
      options: { channel: "#growth" },
    },
    data: context("Priya owns the release notes and will publish them by Friday."),
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.equal(result.successful, true);
  assert.match(
    aiPrompts.at(-1)?.at(-1)?.content ?? "",
    /Priya owns the release notes and will publish them by Friday\./,
  );
  assert.equal(posts.at(-1)?.text, "*Action items*\n• Priya owns the release notes by Friday.");
});
