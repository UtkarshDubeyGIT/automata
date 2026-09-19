import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * Stage 1: rank Composio's catalog down to the integrations worth expanding.
 *
 * The ranking itself is measured against a labelled fixture by
 * scripts/eval-retrieval.ts, which needs a populated index and a live
 * embedding call. What is pinned HERE is everything around the ranking that
 * has to hold even when the ranking is unavailable — because every one of
 * these failures is silent, and every one of them ends in a build that cannot
 * possibly succeed.
 */

let rpcResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
let rpcArgs: Record<string, unknown> | null = null;
let embedBehaviour: () => number[][] = () => [new Array(256).fill(0.1)];

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    embed: async () => embedBehaviour(),
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => ({
      rpc: async (_fn: string, args: Record<string, unknown>) => {
        rpcArgs = args;
        return rpcResult;
      },
    }),
  },
});

function reset() {
  rpcArgs = null;
  rpcResult = { data: [], error: null };
  embedBehaviour = () => [new Array(256).fill(0.1)];
}

test("every app we ship curated specs for is always included", async () => {
  reset();
  // The ranking returns something entirely unrelated.
  rpcResult = { data: [{ slug: "somethingelse", score: 1 }], error: null };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");
  const { APP_LABELS } = await import("@/lib/workflows/registry");

  const result = await retrieveIntegrations("anything at all");
  for (const app of Object.keys(APP_LABELS)) {
    assert.ok(result.selected.includes(app), `${app} fell out of the catalog`);
  }
});

test("a native-only app is reachable even though Composio has no toolkit for it", async () => {
  reset();
  // googlebusinessprofile and vikunja both 404 on Composio's /toolkits, so
  // they can never be ranked. Sourcing the floor from the Composio index
  // instead of our registry would make them permanently unreachable — and
  // Google Business Profile is the app the whole feature was reported against.
  rpcResult = { data: [], error: null };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  const result = await retrieveIntegrations("summarise my business reviews and post to slack");
  assert.ok(result.selected.includes("googlebusinessprofile"));
  assert.ok(result.selected.includes("vikunja"));
});

test("an app the caller pinned survives even when nothing ranks it", async () => {
  reset();
  rpcResult = { data: [], error: null };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  const result = await retrieveIntegrations("add a Slack message after this", {
    keepApps: ["somethingobscure"],
  });
  assert.ok(result.selected.includes("somethingobscure"));
});

test("a failed embedding degrades to lexical rather than returning nothing", async () => {
  reset();
  embedBehaviour = () => {
    throw new Error("no API key");
  };
  rpcResult = { data: [{ slug: "slack", score: 1 }], error: null };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  // Explicit mode: the default is lexical (dense measured worse), so this
  // path only runs for a caller that asked for the embedding half.
  const result = await retrieveIntegrations("post a message to the team", { mode: "hybrid" });
  assert.equal(result.mode, "lexical");
  assert.equal(result.degraded, true);
  assert.ok(result.selected.length > 0, "an embedding failure emptied the catalog");
  assert.equal(rpcArgs?.query_embedding, null, "a null vector must not be sent as a real one");
});

test("a failed index search still yields the curated catalog", async () => {
  reset();
  rpcResult = { data: null, error: { message: "connection refused" } };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  const result = await retrieveIntegrations("post a message to the team");
  assert.equal(result.degraded, true);
  assert.deepEqual(result.ranked, []);
  // Exactly the catalog the builder had before retrieval existed.
  assert.ok(result.selected.includes("slack"));
});

test("a build makes no embedding call", async () => {
  reset();
  let embedCalled = false;
  embedBehaviour = () => {
    embedCalled = true;
    return [new Array(256).fill(0.1)];
  };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  // Dense retrieval measured materially worse than lexical on this corpus
  // (37.9% vs 79.3% recall@20), so the default path must not pay for an
  // embedding round trip — or depend on OpenAI being reachable at all.
  const result = await retrieveIntegrations("post a summary to our team channel");
  assert.equal(embedCalled, false, "the default path called the embedding API");
  assert.equal(result.mode, "lexical");
  assert.equal(result.degraded, false, "the default path must not report itself degraded");
});

test("the lexical half is given the raw request, not a decorated query", async () => {
  reset();
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  const prompt = "post a summary to our team channel";
  await retrieveIntegrations(prompt);
  // Postgres full-text search ANDs its terms, so any preamble added here
  // becomes a term every candidate is required to contain. That is how the
  // lexical half once returned zero results for all 29 fixture cases.
  assert.equal(rpcArgs?.query_text, prompt);
});

test("ranked results are not duplicated into the forced list", async () => {
  reset();
  rpcResult = { data: [{ slug: "slack", score: 2 }], error: null };
  const { retrieveIntegrations } = await import("@/lib/workflows/retrieval");

  const result = await retrieveIntegrations("post to slack", { keepApps: ["slack"] });
  assert.ok(result.ranked.includes("slack"));
  assert.ok(!result.forced.includes("slack"));
  assert.equal(result.selected.filter((s) => s === "slack").length, 1);
});
