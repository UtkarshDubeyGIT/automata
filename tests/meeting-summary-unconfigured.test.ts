import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The other half of `meeting-summary.test.ts`: a deployment with no
 * OPENAI_API_KEY. This mirrors `twilio-otp-unconfigured.test.ts` — one file
 * per provider-configured value, because `openaiConfigured` is read once at
 * import and `mock.module` fixes it for the whole file.
 */

let chatCalls = 0;

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: false,
    chat: async () => {
      chatCalls++;
      throw new Error("chat must never be called when OpenAI is not configured");
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

test("meeting summary returns a tainted preview and never calls the provider when unconfigured", async () => {
  chatCalls = 0;
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  const out = await handler({
    runId: "run-stub",
    stepId: "extract",
    step: { type: "meeting_summary", extract_action_items: true },
    data: { steps: {}, input: { meeting_id: "meet-1", transcript: "Alex will send the proposal." } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never) as { sim?: boolean; provider?: string; actionItems?: unknown; meetingId?: string; text?: string };

  assert.equal(chatCalls, 0, "no transcript text may reach the AI provider when it isn't configured");
  assert.equal(out.sim, true, "the output must be tainted so a live Vikunja write refuses it");
  assert.equal(out.provider, "stub");
  assert.equal(out.meetingId, "meet-1");
  assert.equal(out.actionItems, undefined, "a stub run makes no claim about extracted action items");
  assert.match(String(out.text), /not switched on|add OPENAI_API_KEY/);
});

test("the stub still requires transcript text before returning a preview", async () => {
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  await assert.rejects(
    handler({
      runId: "run-stub-empty",
      stepId: "extract",
      step: { type: "meeting_summary" },
      data: { steps: {}, input: { meeting_id: "meet-2" } },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /transcript/i,
  );
});
