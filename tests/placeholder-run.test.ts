import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The run-time placeholder guard on app_action.
 *
 * `missingSetup` refuses to switch such a workflow on, but graphs saved before
 * that guard existed are still on disk and still claimed — and `a@b.com` in
 * recipient_email mails a stranger for real. This is the last line of defence,
 * and it has to be able to tell three things apart: a stand-in the BUILDER
 * wrote, a reference resolved from an earlier step, and an AI draft that merely
 * looks like one.
 */

const calls: { slug: string; args: Record<string, unknown> }[] = [];

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
      listConnections: async () => [
        { platform: "gmail", status: "connected" },
        { platform: "googlebusinessprofile", status: "connected" },
      ],
    },
    executeTool: async (slug: string, _entity: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      return { successful: true, data: {} };
    },
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");

function run(
  tool: string,
  args: Record<string, unknown>,
  steps: Record<string, Record<string, unknown>> = {},
) {
  calls.length = 0;
  return HANDLERS.app_action({
    runId: "run-1",
    stepId: "act",
    step: { type: "app_action", tool, arguments: args },
    data: { steps },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);
}

test("a required argument the builder answered with a stand-in stops the run", async () => {
  // Exactly what shipped alongside the <owner>/<repo> trigger.
  await assert.rejects(
    () =>
      run("GMAIL_SEND_EMAIL", {
        recipient_email: "a@b.com",
        subject: "New issue",
        body: "…",
      }),
    /recipient_email' is still a placeholder/,
  );
  assert.equal(calls.length, 0, "it called Gmail anyway");
});

test("a real recipient is sent", async () => {
  await run("GMAIL_SEND_EMAIL", {
    recipient_email: "ops@acme.co",
    subject: "New issue",
    body: "text",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.recipient_email, "ops@acme.co");
});

test("a resolved reference is data, not a stand-in", async () => {
  /*
   * The guard's first cut judged the RESOLVED value, so an upstream step whose
   * output happened to look like `<reply>` — which is exactly what the zero-key
   * AI stub emits — hard-failed a step that was configured correctly. What is
   * being judged is what the AUTHOR wrote, so a {{...}} argument is exempt.
   */
  await run(
    "GMAIL_SEND_EMAIL",
    {
      recipient_email: "{{steps.pick.result.to}}",
      subject: "s",
      body: "b",
    },
    { pick: { result: { to: "<reply>" } } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.recipient_email, "<reply>");
});

test("a simulated app never reaches the guard", async () => {
  // Google Business Profile has no Composio toolkit, so the step returns before
  // anything real happens. Failing it for a stand-in would break the shipped
  // reply-to-reviews template on every install with no OPENAI_API_KEY.
  const out = (await run("GOOGLEBUSINESS_REPLY_TO_REVIEW", {
    review_id: "<review id>",
    reply: "<reply>",
  })) as Record<string, unknown>;
  assert.equal(out.simulated, true);
  assert.equal(calls.length, 0);
});
