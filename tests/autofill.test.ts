import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The arguments a step does NOT carry.
 *
 * Meta will not tell us which ad account is yours — Composio's Meta toolkit
 * has no "list my ad accounts" tool at all — so the id lives in Settings and
 * the run reaches for it. That makes it the one place where what Composio
 * receives is not what the saved graph says, which is worth pinning down: an
 * author's value must always win, and a missing one must fail with a sentence
 * rather than a bare 400 from Meta.
 */

let brand: { ads?: { metaAdAccountId?: string }; analytics?: { ga4PropertyId?: string } } | null = null;
const calls: { slug: string; args: Record<string, unknown> }[] = [];
const proxyCalls: Array<{ request: Record<string, unknown> }> = [];

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => brand,
    // steps.ts also grounds the AI node in the brand profile; a mock missing
    // this export fails the whole file at import time.
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    socialProvider: {
      live: true,
      listConnections: async () => [
        { platform: "metaads", status: "connected" },
        { platform: "google_analytics", status: "connected" },
      ],
    },
    executeTool: async (slug: string, _entity: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      return { successful: true, data: { data: [{ spend: "12.34", impressions: "900" }] } };
    },
  },
});

mock.module("@/lib/social/composio-proxy", {
  namedExports: {
    proxyFor: async (_workspaceId: string, _toolkit: string, request: Record<string, unknown>) => {
      proxyCalls.push({ request });
      return {
        status: 200,
        data: {
          dimensionHeaders: [],
          metricHeaders: [],
          rows: [],
          rowCount: 0,
        },
      };
    },
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");

async function runStep(args: Record<string, unknown>) {
  calls.length = 0;
  return HANDLERS.app_action({
    runId: "run-1",
    stepId: "fetch",
    step: { type: "app_action", tool: "METAADS_GET_INSIGHTS", arguments: args },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);
}

test("a bare ad account id from Settings is normalised to act_", async () => {
  brand = { ads: { metaAdAccountId: "1234567890" } };
  await runStep({ date_preset: "yesterday" });
  assert.equal(calls[0].args.object_id, "act_1234567890");
});

test("an already-prefixed id is left alone", async () => {
  brand = { ads: { metaAdAccountId: "act_1234567890" } };
  await runStep({ date_preset: "yesterday" });
  assert.equal(calls[0].args.object_id, "act_1234567890");
});

test("a value written on the step always wins", async () => {
  // Pointing one automation at a campaign, or at a client's account, must not
  // be silently overwritten by the workspace default.
  brand = { ads: { metaAdAccountId: "1234567890" } };
  await runStep({ object_id: "23847239847", date_preset: "yesterday" });
  assert.equal(calls[0].args.object_id, "23847239847");
});

test("no saved id fails with both fixes named, before anything is called", async () => {
  brand = { ads: {} };
  await assert.rejects(
    () => runStep({ date_preset: "yesterday" }),
    (err: Error) => {
      assert.match(err.message, /Settings/);
      assert.match(err.message, /object_id/);
      return true;
    },
  );
  assert.equal(calls.length, 0, "Composio must not be called without an ad account");
});

test("tool constants reach Composio without living in the saved graph", async () => {
  // `fields` is an array. The step's Arguments editor is a grid of text
  // inputs, so an array in the graph becomes a JSON string the first time
  // somebody edits that row — it has to be filled server-side instead.
  brand = { ads: { metaAdAccountId: "act_1" } };
  await runStep({ date_preset: "yesterday" });
  assert.equal(calls[0].args.level, "account");
  assert.deepEqual(calls[0].args.fields, ["spend", "impressions", "clicks", "ctr", "reach"]);
  assert.equal(calls[0].args.date_preset, "yesterday");
});

test("a constant the author overrode is not put back", async () => {
  brand = { ads: { metaAdAccountId: "act_1" } };
  await runStep({ level: "campaign", date_preset: "last_7d" });
  assert.equal(calls[0].args.level, "campaign");
});

test("a GA4 report takes its property from Settings when the action leaves it blank", async () => {
  brand = { analytics: { ga4PropertyId: "123456789" } };
  calls.length = 0;
  proxyCalls.length = 0;
  await HANDLERS.app_action({
    runId: "run-1",
    stepId: "fetch",
    step: { type: "app_action", tool: "GOOGLE_ANALYTICS_RUN_REPORT", arguments: {} },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);
  assert.equal(proxyCalls.length, 1);
  assert.match(String(proxyCalls[0].request.endpoint), /properties\/123456789:runReport$/);
});

test("the legacy GA4 manual-input reference falls back to the Settings property", async () => {
  brand = { analytics: { ga4PropertyId: "123456789" } };
  proxyCalls.length = 0;

  await HANDLERS.app_action({
    runId: "run-1",
    stepId: "fetch",
    step: {
      type: "app_action",
      tool: "GOOGLE_ANALYTICS_RUN_REPORT",
      arguments: { property: "{{steps.manual_start.input.google_analytics_property}}" },
    },
    data: { input: {}, steps: { manual_start: { input: {} } } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.equal(proxyCalls.length, 1);
  assert.match(String(proxyCalls[0].request.endpoint), /properties\/123456789:runReport$/);
});

test("a supplied legacy GA4 manual input overrides the Settings property", async () => {
  brand = { analytics: { ga4PropertyId: "123456789" } };
  proxyCalls.length = 0;

  await HANDLERS.app_action({
    runId: "run-1",
    stepId: "fetch",
    step: {
      type: "app_action",
      tool: "GOOGLE_ANALYTICS_RUN_REPORT",
      arguments: { property: "{{steps.manual_start.input.google_analytics_property}}" },
    },
    data: {
      input: { google_analytics_property: "987654321" },
      steps: { manual_start: { input: { google_analytics_property: "987654321" } } },
    },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.equal(proxyCalls.length, 1);
  assert.match(String(proxyCalls[0].request.endpoint), /properties\/987654321:runReport$/);
});

test("a GA4 report without an override or saved property fails before calling Google", async () => {
  brand = { analytics: {} };
  proxyCalls.length = 0;

  await assert.rejects(
    HANDLERS.app_action({
      runId: "run-1",
      stepId: "fetch",
      step: { type: "app_action", tool: "GOOGLE_ANALYTICS_RUN_REPORT", arguments: {} },
      data: { steps: {} },
      entityId: "ws-1",
      reads: new Set<string>(),
    } as never),
    /Settings.*Google Analytics/i,
  );
  assert.equal(proxyCalls.length, 0);
});

test("metric rows survive the flattener that feeds the next AI step", async () => {
  // An insights row has no title, no status and no body. Before the scalar
  // fallback this whole record flattened to "- (untitled)" and the report the
  // user got emailed contained no numbers at all.
  brand = { ads: { metaAdAccountId: "act_1" } };
  const out = await runStep({ date_preset: "yesterday" });
  assert.match(String(out.text), /spend=12\.34/);
  assert.match(String(out.text), /impressions=900/);
});
