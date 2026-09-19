import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import type { ToolSpec } from "@/lib/workflows/registry";

const STRIPE_SPEC: ToolSpec = {
  app: "stripe",
  kind: "write",
  external: true,
  required: ["customer"],
  desc: "Create an invoice",
  argHint: '{"customer":""}',
  version: "20260901_00",
};

/** Specs `selectTools` claims to have already resolved while building the catalog. */
let selectionSpecs: Record<string, ToolSpec> = {};
/** Live lookups the builder had to make anyway. */
let findToolSpecCalls: string[] = [];

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async () =>
      JSON.stringify({
        title: "Stripe Invoice Workflow",
        description: "Creates an invoice",
        start: "start",
        steps: {
          start: { type: "manual_trigger_input", title: "Manual Start", next: "create_inv" },
          create_inv: {
            type: "app_action",
            title: "Create Invoice",
            tool: "STRIPE_CREATE_INVOICE",
            arguments: { customer: "cus_abc" },
            next: null,
          },
        },
      }),
  },
});

// Tool selection is exercised in tests/tool-selection.test.ts. Stubbing it
// here keeps this test about what it is named for — that a tool slug absent
// from the curated registry still resolves and gets its spec attached — and
// off the network.
mock.module("@/lib/workflows/tool-selection", {
  namedExports: {
    selectTools: async () => ({
      text: '  - STRIPE_CREATE_INVOICE (stripe, WRITE [external/visible]): Create an invoice — args: {"customer":""}',
      integrations: ["stripe"],
      specs: selectionSpecs,
      degraded: false,
    }),
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    findToolSpec: async (slug: string) => {
      findToolSpecCalls.push(slug);
      return slug === "STRIPE_CREATE_INVOICE" ? STRIPE_SPEC : null;
    },
    PLATFORMS: [],
  },
});

test("builder normalizes dynamic action and attaches tool_spec", async () => {
  selectionSpecs = {};
  findToolSpecCalls = [];
  const { buildWorkflow } = await import("@/lib/workflows/builder");
  const build = await buildWorkflow("Create an invoice in Stripe");
  const step = build.config.graph.steps.create_inv;

  assert.equal(step.tool, "STRIPE_CREATE_INVOICE");
  assert.equal(step.toolkit, "stripe");
  assert.deepEqual(step.tool_spec, STRIPE_SPEC);
});

test("a spec already resolved while building the catalog is not looked up again", async () => {
  /*
   * `selectTools` fetches and normalizes every tool in the chosen toolkits to
   * render the catalog, so re-fetching one the model then picked is a wasted
   * round trip per app_action step — and an uncached one. It is also a
   * failure mode: if that re-fetch fails, a slug that was perfectly valid
   * resolves to nothing and burns a repair attempt.
   */
  selectionSpecs = { STRIPE_CREATE_INVOICE: STRIPE_SPEC };
  findToolSpecCalls = [];
  const { buildWorkflow } = await import("@/lib/workflows/builder");
  const build = await buildWorkflow("Create an invoice in Stripe");

  assert.deepEqual(build.config.graph.steps.create_inv.tool_spec, STRIPE_SPEC);
  assert.deepEqual(
    findToolSpecCalls,
    [],
    `the builder re-fetched specs it already had: ${findToolSpecCalls.join(", ")}`,
  );
});
