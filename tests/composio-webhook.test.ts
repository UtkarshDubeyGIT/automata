import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { mock, test } from "node:test";

/**
 * The inbound edge: what happens when Composio actually pushes an event.
 *
 * This route had no tests at all, which mattered more than the usual gap. It is
 * the only entry point in the product that an unauthenticated stranger on the
 * internet can reach AND that starts charged runs against real accounts, and
 * every one of its decisions is a silent one — it answers 200 to almost
 * everything, on purpose, because a 4xx makes Composio retry a delivery nobody
 * wants. So a mistake here does not show up as an error; it shows up as
 * automations that quietly stop firing, or fire twice, or fire for the wrong
 * workspace.
 *
 * The live half is covered elsewhere: `composio-tools.mjs --watch-probe`
 * subscribes each trigger for real and reports whether Composio calls it a push
 * or a poll. What it cannot do is make Composio deliver on demand, so the
 * deliveries here are signed by hand with the real HMAC scheme.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";
process.env.COMPOSIO_WEBHOOK_SECRET = "test-signing-secret";

const SECRET = "test-signing-secret";
const INSTANCE = "ti_abc123";

const claims: Record<string, unknown>[] = [];
let claimResult: Record<string, unknown> = {
  runId: "run-1",
  status: "queued",
  duplicate: false,
};
const demotions: string[] = [];

mock.module("@/lib/workflows/claim", {
  namedExports: {
    claimRun: async (args: Record<string, unknown>) => {
      claims.push(args);
      return claimResult;
    },
  },
});

mock.module("@/lib/workflows/realtime", {
  namedExports: {
    demoteToPolling: async (_db: unknown, triggerId: string) => {
      demotions.push(triggerId);
      return "wf-1";
    },
  },
});

/** One workflow row, found by the instance id the delivery names. */
let row: Record<string, unknown> | null = null;
let lastFilter = "";
mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => ({
      from: () => {
        const chain = {
          select: () => chain,
          eq: (col: string, val: string) => {
            lastFilter = `${col}=${val}`;
            return chain;
          },
          limit: () => chain,
          async maybeSingle() {
            return { data: row };
          },
        };
        return chain;
      },
    }),
  },
});

const { POST } = await import("@/app/api/composio/triggers/route");

/** A delivery signed the way Composio signs one. */
function delivery(
  body: Record<string, unknown>,
  opts: { secret?: string; at?: number; id?: string } = {},
) {
  const raw = JSON.stringify(body);
  const id = opts.id ?? "msg_1";
  const ts = String(Math.floor((opts.at ?? Date.now()) / 1000));
  const sig = createHmac("sha256", opts.secret ?? SECRET)
    .update(`${id}.${ts}.${raw}`)
    .digest("base64");
  return {
    text: async () => raw,
    headers: new Headers({
      "webhook-id": id,
      "webhook-timestamp": ts,
      "webhook-signature": `v1,${sig}`,
    }),
  } as never;
}

function githubIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "composio.trigger.message",
    metadata: { trigger_id: INSTANCE, trigger_slug: "GITHUB_ISSUE_ADDED_EVENT" },
    data: { title: "Login is broken", description: "on Safari", number: 42 },
    ...overrides,
  };
}

const WORKFLOW = {
  id: "wf-1",
  workspace_id: "ws-1",
  active: true,
  config: {
    graph: {
      start: "trigger",
      steps: {
        trigger: { type: "app_event_trigger", event: "NEW_GITHUB_ISSUE", next: null },
      },
    },
  },
  trigger_state: { realtime: { instanceId: INSTANCE, mode: "push" } },
};

function reset() {
  claims.length = 0;
  demotions.length = 0;
  row = JSON.parse(JSON.stringify(WORKFLOW));
  claimResult = { runId: "run-1", status: "queued", duplicate: false };
}

test("a correctly signed delivery enqueues exactly one run", async () => {
  reset();
  const res = await POST(delivery(githubIssue()));
  assert.equal(res.status, 200);
  assert.equal(claims.length, 1);
  assert.equal(claims[0].workflowId, "wf-1");
  assert.equal(claims[0].workspaceId, "ws-1");
  // Enqueue, never execute: this request is Composio's, and driving a whole
  // workflow inside it would hold their delivery open for minutes.
  assert.equal(claims[0].mode, "enqueue");
});

test("the delivery id is the idempotency key, so a redelivery is not a second run", async () => {
  reset();
  await POST(delivery(githubIssue({ id: "msg_77" }), { id: "msg_77" }));
  assert.equal(claims[0].idempotencyKey, "composio:msg_77");
});

test("the pushed payload is mapped into the trigger's declared event shape", async () => {
  reset();
  await POST(delivery(githubIssue()));
  const input = claims[0].input as Record<string, unknown>;
  // GitHub spells these `description`/`number` on a push and `body`/`number`
  // on the REST listing, so mapping is what makes {{steps.trigger.event.body}}
  // mean the same thing however the event arrived.
  assert.equal(input.title, "Login is broken");
  assert.equal(input.body, "on Safari");
  // The raw payload always rides along for anything the mapping doesn't name.
  assert.ok(input.raw, "the unmapped payload must survive");
});

test("an unsigned delivery is refused, and starts nothing", async () => {
  reset();
  const raw = JSON.stringify(githubIssue());
  const res = await POST({
    text: async () => raw,
    headers: new Headers({}),
  } as never);
  assert.equal(res.status, 401);
  assert.equal(claims.length, 0);
});

test("a delivery signed with the wrong secret is refused", async () => {
  reset();
  const res = await POST(delivery(githubIssue(), { secret: "not-the-secret" }));
  assert.equal(res.status, 401);
  assert.equal(claims.length, 0);
});

test("a delivery older than the replay window is refused", async () => {
  reset();
  // Correctly signed, but stale — a captured delivery replayed later must not
  // be able to re-run somebody's automation.
  const res = await POST(delivery(githubIssue(), { at: Date.now() - 60 * 60 * 1000 }));
  assert.equal(res.status, 401);
  assert.equal(claims.length, 0);
});

test("a watch we no longer own is ignored with a 200, not a retry-inducing error", async () => {
  reset();
  row = null;
  const res = await POST(delivery(githubIssue()));
  assert.equal(res.status, 200);
  assert.equal(claims.length, 0);
  assert.equal((await res.json()).ignored, "no workflow for this trigger");
});

test("a paused automation receives nothing", async () => {
  reset();
  (row as Record<string, unknown>).active = false;
  const res = await POST(delivery(githubIssue()));
  assert.equal(claims.length, 0);
  assert.equal((await res.json()).ignored, "automation is paused");
});

test("the workflow is found by the instance id the delivery names", async () => {
  reset();
  await POST(delivery(githubIssue()));
  // One endpoint serves every workspace, so this filter is the only thing
  // deciding whose automation runs. Getting it wrong fires the wrong tenant's.
  assert.equal(lastFilter, `trigger_state->realtime->>instanceId=${INSTANCE}`);
});

test("Composio switching a watch off demotes that workflow to polling", async () => {
  reset();
  const res = await POST(
    delivery(githubIssue({ type: "composio.trigger.disabled" })),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(demotions, [INSTANCE]);
  // Critically it must NOT also start a run — nothing happened in the app.
  assert.equal(claims.length, 0);
});

test("a workspace with no credits is reported, but still answered 200", async () => {
  reset();
  claimResult = { refused: { reason: "insufficient_credits" }, error: "Not enough credits" };
  const res = await POST(delivery(githubIssue()));
  // Retrying will not conjure credits, and a 4xx makes Composio back off the
  // whole project's subscription — which would break every other workspace.
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, false);
});

test("a delivery with no trigger id is ignored rather than guessed at", async () => {
  reset();
  const res = await POST(delivery(githubIssue({ metadata: {} })));
  assert.equal(claims.length, 0);
  assert.equal((await res.json()).ignored, "no trigger id");
});
