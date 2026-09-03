import { strict as assert } from "node:assert";
import { test } from "node:test";
import { requestRun, resetPendingKeys } from "@/lib/workflows/run-request";
import { liveWrites } from "@/lib/workflows/validate";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * What the Run button is allowed to conclude from a request that came back
 * badly — and what the press after that is allowed to do.
 */

/** A fetch stand-in that records the idempotency key of every attempt. */
function fakeFetch(replies: (() => Promise<Response> | never)[]) {
  const keys: string[] = [];
  let i = 0;
  const impl = (async (_url: string, init: RequestInit) => {
    keys.push(String((init.headers as Record<string, string>)["x-run-nonce"]));
    return replies[Math.min(i++, replies.length - 1)]();
  }) as unknown as typeof fetch;
  return { impl, keys };
}

const json = (body: unknown, status = 200) => async () =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** What nginx returns when it gives up on a run that is still going. */
const gatewayTimeout = () => async () =>
  new Response("<html>504 Gateway Time-out</html>", { status: 504 });

test("a proxy 504 is 'unknown', never a failed run", async () => {
  resetPendingKeys();
  const { impl } = fakeFetch([gatewayTimeout()]);
  const outcome = await requestRun("wf-1", impl);
  assert.deepEqual(outcome, { kind: "unknown", reason: "gateway" });
});

test("an aborted fetch is 'unknown' too — aborting does not abort the run", async () => {
  resetPendingKeys();
  const { impl } = fakeFetch([
    async () => {
      throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
    },
  ]);
  assert.deepEqual(await requestRun("wf-1", impl), { kind: "unknown", reason: "timeout" });
});

test("the press after an unanswered attempt re-sends the SAME key", async () => {
  resetPendingKeys();
  // The run is still going when the proxy gives up; the user presses Run again.
  const { impl, keys } = fakeFetch([
    gatewayTimeout(),
    json({ run: { status: "running" }, duplicate: true }),
  ]);
  assert.equal((await requestRun("wf-2", impl)).kind, "unknown");
  const second = await requestRun("wf-2", impl);

  assert.equal(keys.length, 2);
  // Same key => claimRun's unique index refuses the second claim, so the
  // second press costs nothing and publishes nothing.
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(second, { kind: "started", status: "running", error: undefined, duplicate: true });
});

test("once the server answers, the next press is a genuinely new run", async () => {
  resetPendingKeys();
  const { impl, keys } = fakeFetch([json({ run: { status: "completed" }, duplicate: false })]);
  await requestRun("wf-3", impl);
  await requestRun("wf-3", impl);
  assert.notEqual(keys[0], keys[1]);
});

test("keys are per workflow, not shared across the list", async () => {
  resetPendingKeys();
  const { impl, keys } = fakeFetch([gatewayTimeout()]);
  await requestRun("wf-a", impl);
  await requestRun("wf-b", impl);
  assert.notEqual(keys[0], keys[1]);
});

test("a JSON refusal from our own route is a refusal, not an unknown", async () => {
  resetPendingKeys();
  const { impl } = fakeFetch([json({ error: "This automation has no runnable graph" }, 400)]);
  assert.deepEqual(await requestRun("wf-4", impl), {
    kind: "refused",
    message: "This automation has no runnable graph",
  });
});

test("402 carries the balance so the toast can name the shortfall", async () => {
  resetPendingKeys();
  const { impl } = fakeFetch([json({ error: "Not enough credits", balance: 1, cost: 2 }, 402)]);
  assert.deepEqual(await requestRun("wf-5", impl), {
    kind: "insufficient_credits",
    balance: 1,
    cost: 2,
  });
});

// ---------------------------------------------------------------------------
// What Run is about to do to the outside world
// ---------------------------------------------------------------------------

const SAMPLE_FED: WorkflowGraph = {
  start: "trigger",
  steps: {
    trigger: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "draft" },
    draft: { type: "ai_step", instruction: "write a reply", next: "look" },
    // A read changes nothing, so it is not something to warn about.
    look: { type: "app_action", tool: "GITHUB_LIST_REPOSITORY_ISSUES", title: "Check issues", next: "send" },
    send: { type: "social_post", platform: "linkedin", title: "Publish", text: "{{steps.draft.text}}" },
  },
};

test("the irreversible steps of a sample-fed run are named, reads are not", () => {
  const writes = liveWrites(SAMPLE_FED);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^Publish — posts to LinkedIn$/);
});

test("an app with no Composio toolkit always simulates, so it is not a live write", () => {
  // Google Business Profile is in SIMULATED_APPS: the call never leaves us.
  const writes = liveWrites({
    start: "t",
    steps: {
      t: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "reply" },
      reply: { type: "app_action", tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW", title: "Reply" },
    },
  });
  assert.deepEqual(writes, []);
});
