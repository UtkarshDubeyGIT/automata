import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let prompts: string[] = [];

/** Swappable per test so a single mocked module can model every provider variation. */
let actionItemsReply: () => string = () =>
  JSON.stringify({ items: [
    { title: "Send proposal", description: "Owner mentioned: Alex\nDeadline mentioned: Friday" },
    { title: "Book follow-up", description: "" },
  ] });

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async (messages: { role: string; content: string }[]) => {
      prompts.push(messages.at(-1)?.content ?? "");
      if (messages[0]?.content.includes("action items as JSON")) {
        return actionItemsReply();
      }
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

test("meeting summary can persist structured action items from the complete notes", async () => {
  prompts = [];
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  const out = await handler({
    runId: "run-actions",
    stepId: "extract",
    step: { type: "meeting_summary", transcript_field: "transcript", extract_action_items: true },
    data: { steps: {}, input: { meeting_id: "meet-3", title: "Product sync", transcript: "Alex will send the proposal by Friday." } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never) as { actionItems?: unknown[] };

  assert.deepEqual(out.actionItems, [
    { title: "Send proposal", description: "Owner mentioned: Alex\nDeadline mentioned: Friday" },
    { title: "Book follow-up", description: "" },
  ]);
});

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

test("meeting summary refuses a non-string transcript field", async () => {
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  await assert.rejects(
    handler({
      runId: "run-bad-type",
      stepId: "summarize",
      step: { type: "meeting_summary" },
      data: { steps: {}, input: { meeting_id: "meet-2", transcript: 12345 } },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /transcript/i,
  );
});

test("meeting summary reads transcript from a custom field name", async () => {
  prompts = [];
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  const out = await handler({
    runId: "run-custom-field",
    stepId: "summarize",
    step: { type: "meeting_summary", transcript_field: "body.transcript_text" },
    data: { steps: {}, input: { meeting_id: "meet-9", "body.transcript_text": "Alex owns the proposal." } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never) as { meetingId: string };
  assert.equal(out.meetingId, "meet-9");
  assert.ok(prompts.some((prompt) => prompt.includes("Alex owns the proposal.")));
});

test("extract_action_items accepts the string form 'true' the same as boolean true", async () => {
  prompts = [];
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  const out = await handler({
    runId: "run-string-true",
    stepId: "extract",
    step: { type: "meeting_summary", extract_action_items: "true" },
    data: { steps: {}, input: { meeting_id: "meet-3", transcript: "Alex will send the proposal." } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never) as { actionItems?: unknown[] };
  assert.equal(out.actionItems?.length, 2);
});

test("action-item extraction rejects a model reply with no items array", async () => {
  prompts = [];
  actionItemsReply = () => JSON.stringify({ notes: "no items key at all" });
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  await assert.rejects(
    handler({
      runId: "run-bad-json",
      stepId: "extract",
      step: { type: "meeting_summary", extract_action_items: true },
      data: { steps: {}, input: { meeting_id: "meet-4", transcript: "Some notes." } },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /invalid output/,
  );
});

test("action-item extraction rejects an item with a missing or blank title, naming its index", async () => {
  prompts = [];
  actionItemsReply = () => JSON.stringify({ items: [
    { title: "Send proposal", description: "ok" },
    { title: "   ", description: "blank title" },
  ] });
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  await assert.rejects(
    handler({
      runId: "run-blank-title",
      stepId: "extract",
      step: { type: "meeting_summary", extract_action_items: true },
      data: { steps: {}, input: { meeting_id: "meet-5", transcript: "Some notes." } },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /action item 2/i,
  );
});

test("action-item extraction caps at 50 items and truncates oversized title/description", async () => {
  prompts = [];
  const longTitle = "T".repeat(300);
  const longDescription = "D".repeat(11_000);
  actionItemsReply = () => JSON.stringify({
    items: [
      { title: longTitle, description: longDescription },
      ...Array.from({ length: 60 }, (_, i) => ({ title: `Item ${i}`, description: "" })),
    ],
  });
  const handler = (steps.HANDLERS as Record<string, typeof steps.HANDLERS.ai_step>).meeting_summary;
  const out = await handler({
    runId: "run-cap",
    stepId: "extract",
    step: { type: "meeting_summary", extract_action_items: true },
    data: { steps: {}, input: { meeting_id: "meet-6", transcript: "Lots of items." } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never) as { actionItems: Array<{ title: string; description: string }> };

  assert.equal(out.actionItems.length, 50, "the batch tool's own 50-item cap starts here");
  assert.equal(out.actionItems[0]!.title.length, 250);
  assert.equal(out.actionItems[0]!.description.length, 10_000);
});
