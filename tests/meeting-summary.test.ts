import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let prompts: string[] = [];

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async (messages: { role: string; content: string }[]) => {
      prompts.push(messages.at(-1)?.content ?? "");
      return prompts.length === 1 ? "notes from chunk one" :
        prompts.length === 2 ? "notes from chunk two" : "*Meeting summary*\n\n*Decisions*\nShip it.";
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

mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => ({ from: () => ({}) }) },
});

const steps = await import("@/lib/workflows/steps");

test("meeting summary processes the complete webhook transcript in chunks", async () => {
  prompts = [];
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  assert.equal(typeof handler, "function", "meeting_summary handler should exist");

  const first = "A".repeat(12_000);
  const second = "B".repeat(12_000);
  const out = await handler({
    runId: "run-meeting",
    stepId: "summarize",
    step: { type: "meeting_summary", transcript_field: "transcript" },
    data: { steps: {}, input: { meeting_id: "meet-1", title: "Product sync", transcript: first + second } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.equal(prompts.length, 3, "two chunk extractions and one synthesis");
  assert.ok(prompts.some((prompt) => prompt.includes(first)));
  assert.ok(prompts.some((prompt) => prompt.includes(second)));
  assert.equal(out.text, "*Meeting summary*\n\n*Decisions*\nShip it.");
  assert.equal(out.meetingId, "meet-1");
});

test("meeting summary refuses a webhook without transcript text", async () => {
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  assert.equal(typeof handler, "function", "meeting_summary handler should exist");
  await assert.rejects(
    handler({
      runId: "run-empty",
      stepId: "summarize",
      step: { type: "meeting_summary" },
      data: { steps: {}, input: { meeting_id: "meet-2" } },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /transcript/i,
  );
});
