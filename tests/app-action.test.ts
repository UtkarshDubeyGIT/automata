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
const proxyCalls: Array<{ entityId: string; toolkit: string; request: Record<string, unknown> }> = [];
let proxyResult: { status: number; data: Record<string, unknown> } | null = {
  status: 200,
  data: {
    dimensionHeaders: [{ name: "date" }],
    metricHeaders: [{ name: "activeUsers" }],
    rows: [{ dimensionValues: [{ value: "20260920" }], metricValues: [{ value: "42" }] }],
    rowCount: 1,
  },
};
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

mock.module("@/lib/social/composio-proxy", {
  namedExports: {
    proxyFor: async (entityId: string, toolkit: string, request: Record<string, unknown>) => {
      proxyCalls.push({ entityId, toolkit, request });
      return proxyResult;
    },
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

test("a GA4 report uses the token-safe proxy and returns readable metric rows", async () => {
  connections = [{ platform: "google_analytics", status: "connected" }];
  proxyCalls.length = 0;
  proxyResult = {
    status: 200,
    data: {
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: [{ name: "activeUsers" }],
      rows: [{ dimensionValues: [{ value: "20260920" }], metricValues: [{ value: "42" }] }],
      rowCount: 1,
    },
  };

  const out = await run({
    tool: "GOOGLE_ANALYTICS_RUN_REPORT",
    arguments: { property: "123456789" },
  }) as Record<string, unknown>;

  assert.equal(proxyCalls.length, 1);
  assert.equal(proxyCalls[0].toolkit, "google_analytics");
  assert.equal(
    proxyCalls[0].request.endpoint,
    "https://analyticsdata.googleapis.com/v1beta/properties/123456789:runReport",
  );
  assert.deepEqual(proxyCalls[0].request.body, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
    dimensions: [{ name: "date" }],
    metrics: [{ name: "activeUsers" }, { name: "sessions" }, { name: "screenPageViews" }],
    limit: 100,
  });
  assert.match(String(out.text), /date=20260920/);
  assert.match(String(out.text), /activeUsers=42/);
});

test("a GA4 report parses flexible JSON arguments before calling Google", async () => {
  connections = [{ platform: "google_analytics", status: "connected" }];
  proxyCalls.length = 0;

  await run({
    tool: "GOOGLE_ANALYTICS_RUN_REPORT",
    arguments: {
      property: "properties/987654321",
      date_ranges: '[{"startDate":"2026-09-01","endDate":"2026-09-19"}]',
      dimensions: '["country"]',
      metrics: '["sessions"]',
      dimension_filter: '{"filter":{"fieldName":"country"}}',
      order_bys: '[{"metric":{"metricName":"sessions"},"desc":true}]',
      metric_aggregations: '["TOTAL"]',
      limit: 25,
      offset: 5,
    },
  });

  assert.deepEqual(proxyCalls[0].request.body, {
    dateRanges: [{ startDate: "2026-09-01", endDate: "2026-09-19" }],
    dimensions: [{ name: "country" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: { filter: { fieldName: "country" } },
    orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    metricAggregations: ["TOTAL"],
    limit: 25,
    offset: "5",
  });
});

test("a GA4 report permits an aggregate-only report without dimensions", async () => {
  connections = [{ platform: "google_analytics", status: "connected" }];
  proxyCalls.length = 0;

  await run({
    tool: "GOOGLE_ANALYTICS_RUN_REPORT",
    arguments: { property: "123456789", dimensions: "[]", metrics: '["sessions"]' },
  });

  assert.deepEqual(proxyCalls[0].request.body, {
    dateRanges: [{ startDate: "30daysAgo", endDate: "today" }],
    dimensions: [],
    metrics: [{ name: "sessions" }],
    limit: 100,
  });
});

test("an invalid GA4 JSON argument fails before a provider request", async () => {
  connections = [{ platform: "google_analytics", status: "connected" }];
  proxyCalls.length = 0;

  await assert.rejects(
    run({
      tool: "GOOGLE_ANALYTICS_RUN_REPORT",
      arguments: { property: "123456789", metrics: "not-json" },
    }),
    /metrics must be valid JSON/,
  );
  assert.equal(proxyCalls.length, 0);
});

test("a rate-limited GA4 response names the retryable provider failure", async () => {
  connections = [{ platform: "google_analytics", status: "connected" }];
  proxyCalls.length = 0;
  proxyResult = { status: 429, data: { error: { message: "quota exhausted" } } };

  await assert.rejects(
    run({ tool: "GOOGLE_ANALYTICS_RUN_REPORT", arguments: { property: "123456789" } }),
    /rate limited.*quota exhausted/i,
  );
  assert.equal(proxyCalls.length, 1);
});
