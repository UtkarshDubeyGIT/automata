import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

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

mock.module("@/lib/social/composio", {
  namedExports: {
    findToolSpec: async (slug: string) => {
      if (slug === "STRIPE_CREATE_INVOICE") {
        return {
          app: "stripe",
          kind: "write" as const,
          external: true,
          required: ["customer"],
          desc: "Create an invoice",
          argHint: '{"customer":""}',
          version: "20260901_00",
        };
      }
      return null;
    },
    PLATFORMS: [],
  },
});

test("builder normalizes dynamic action and attaches tool_spec", async () => {
  const { buildWorkflow } = await import("@/lib/workflows/builder");
  const build = await buildWorkflow("Create an invoice in Stripe");
  const step = build.config.graph.steps.create_inv;

  assert.equal(step.tool, "STRIPE_CREATE_INVOICE");
  assert.equal(step.toolkit, "stripe");
  assert.deepEqual(step.tool_spec, {
    app: "stripe",
    kind: "write",
    external: true,
    required: ["customer"],
    desc: "Create an invoice",
    argHint: '{"customer":""}',
    version: "20260901_00",
  });
});
