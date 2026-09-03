import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * What `app_action` does around the provider call.
 *
 * The live half is covered by `scripts/service-probe.ts`, which runs every
 * registry tool against a real account through this same handler. What a live
 * probe cannot assert is the behaviour that only shows up when something goes
 * wrong — a timeout, a disconnected account, an argument that never resolved —
 * because provoking those against a real provider means breaking it on purpose.
 *
 * Autofill, the placeholder guard and simulation taint are covered by
 * `autofill.test.ts`, `placeholder-run.test.ts` and `taint.test.ts`; this file
 * deliberately does not repeat them.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

let connections: { platform: string; status: string }[] = [
  { platform: "github", status: "connected" },
];
const calls: { slug: string; args: Record<string, unknown>; opts?: { retries?: number } }[] = [];
let failTimes = 0;

mock.module("@/lib/social/composio", {
  namedExports: {
    socialProvider: {
      live: true,
      listConnections: async () => connections,
    },
    executeTool: async (
      slug: string,
      _entity: string,
      args: Record<string, unknown>,
      opts?: { retries?: number },
    ) => {
      calls.push({ slug, args, opts });
      // Model `api()`'s retry contract: it retries internally up to `retries`,
      // so a handler that passes none gets exactly one attempt.
      const budget = 1 + (opts?.retries ?? 0);
      let attempts = 0;
      while (attempts < budget) {
        attempts += 1;
        if (attempts > failTimes) {
          return { successful: true, data: { ok: true, attempts } };
        }
      }
      throw new Error("provider timed out");
    },
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => null,
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");

async function run(step: Record<string, unknown>, data: Record<string, unknown> = { steps: {} }) {
  calls.length = 0;
  return HANDLERS.app_action({
    runId: "run-1",
    stepId: "act",
    step: { type: "app_action", ...step },
    data,
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);
}

test("a read is allowed one retry; a write is allowed none", async () => {
  connections = [{ platform: "github", status: "connected" }];
  failTimes = 0;

  await run({ tool: "GITHUB_LIST_REPOSITORY_ISSUES", arguments: { owner: "o", repo: "r" } });
  assert.equal(calls[0].opts?.retries, 1, "a read is idempotent, so it may be retried");

  await run({ tool: "GITHUB_CREATE_AN_ISSUE", arguments: { owner: "o", repo: "r", title: "t" } });
  // The one that matters: a write that times out may well have LANDED at the
  // provider, so retrying it opens the issue twice. `undefined` is the absence
  // of a retry budget, not a default of one.
  assert.equal(calls[0].opts?.retries, undefined, "a write must never be retried");
});

test("a disconnected account fails before the provider is called, and names the fix", async () => {
  connections = [];
  await assert.rejects(
    run({ tool: "GITHUB_LIST_REPOSITORY_ISSUES", arguments: { owner: "o", repo: "r" } }),
    /github is not connected/,
  );
  assert.equal(calls.length, 0, "nothing should reach the provider");
});

test("an unresolved template is caught even in an argument nothing requires", async () => {
  connections = [{ platform: "github", status: "connected" }];
  // `title` is required and would be checked by any implementation; `body` is
  // optional, and an optional field still holding a literal "{{steps.x.y}}" is
  // a template string landing in somebody's real record.
  await assert.rejects(
    run({
      tool: "GITHUB_CREATE_AN_ISSUE",
      arguments: { owner: "o", repo: "r", title: "real", body: "{{steps.missing.text}}" },
    }),
    /argument 'body'/,
  );
  assert.equal(calls.length, 0);
});

test("an app with no toolkit runs simulated even against a live provider", async () => {
  connections = [];
  const out = await run({ tool: "GOOGLEBUSINESS_GET_REVIEWS", arguments: {} });
  // Derived from the APP, never from the connection row — a toolkit-less app
  // gets a cached "connected" row written for it, so trusting the row is how
  // Google Business Profile showed a green check over fabricated calls.
  assert.equal(out.simulated, true);
  assert.equal(out.sim, true, "simulated output must be tainted so a live write refuses it");
  assert.equal(calls.length, 0, "a simulated app must never reach Composio");
  assert.match(String(out.text), /record/);
});
