import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { BuildError, validateGraph, missingSetup } from "@/lib/workflows/validate";
import type { WorkflowGraph } from "@/lib/workflows/types";
import type { ToolSpec } from "@/lib/workflows/registry";

const stripeToolSpec: ToolSpec = {
  app: "stripe",
  kind: "write",
  external: true,
  required: ["customer", "amount"],
  desc: "Create a charge for a customer in Stripe",
  argHint: '{"customer":"","amount":0}',
  version: "20260901_00",
};

test("validateGraph accepts dynamic app_action when tool_spec snapshot is attached", () => {
  const dynamicGraph: WorkflowGraph = {
    start: "start",
    steps: {
      start: {
        type: "manual_trigger_input",
        title: "Start",
        next: "charge",
      },
      charge: {
        type: "app_action",
        title: "Create Stripe charge",
        tool: "STRIPE_CREATE_CHARGE",
        toolkit: "stripe",
        tool_spec: stripeToolSpec,
        arguments: {
          customer: "cus_123",
          amount: 5000,
        },
        next: null,
      },
    },
  };

  assert.doesNotThrow(() => validateGraph(dynamicGraph));
});

test("validateGraph rejects unknown app_action when no valid tool_spec snapshot is present", () => {
  const invalidGraph: WorkflowGraph = {
    start: "start",
    steps: {
      start: {
        type: "manual_trigger_input",
        title: "Start",
        next: "charge",
      },
      charge: {
        type: "app_action",
        title: "Create Stripe charge",
        tool: "STRIPE_CREATE_CHARGE",
        toolkit: "stripe",
        arguments: {},
        next: null,
      },
    },
  };

  assert.throws(
    () => validateGraph(invalidGraph),
    (err: Error) => err instanceof BuildError && err.message.includes("unknown app action"),
  );
});

test("missingSetup checks required fields from dynamic tool_spec", () => {
  const stepMissingRequired = {
    type: "app_action" as const,
    title: "Create Stripe charge",
    tool: "STRIPE_CREATE_CHARGE",
    tool_spec: stripeToolSpec,
    arguments: {
      customer: "cus_123",
      // amount is missing
    },
    next: null,
  };

  const missing = missingSetup(stepMissingRequired);
  assert.ok(missing.includes("Fill in “amount”"));
});

test("appAction step executes dynamic action and checks required connection and version", async () => {
  const executedCalls: { slug: string; entityId: string; args: Record<string, unknown>; opts?: unknown }[] = [];

  mock.module("@/lib/social/composio", {
    namedExports: {
      socialProvider: {
        live: true,
        listConnections: async () => [
          { platform: "stripe", status: "connected", accountId: "acc_stripe_1" },
        ],
      },
      executeTool: async (
        slug: string,
        entityId: string,
        args: Record<string, unknown>,
        opts?: unknown,
      ) => {
        executedCalls.push({ slug, entityId, args, opts });
        return { successful: true, data: { id: "ch_test_123" } };
      },
    },
  });

  const { HANDLERS } = await import("@/lib/workflows/steps");

  const result = await HANDLERS.app_action({
    stepId: "charge_step",
    step: {
      type: "app_action",
      tool: "STRIPE_CREATE_CHARGE",
      tool_spec: stripeToolSpec,
      arguments: {
        customer: "cus_123",
        amount: 2500,
      },
      next: null,
    },
    data: { steps: {} },
    reads: new Set(),
    entityId: "ws_test_entity",
    runId: "run_test_123",
  });

  assert.equal(executedCalls.length, 1);
  assert.equal(executedCalls[0].slug, "STRIPE_CREATE_CHARGE");
  assert.equal(executedCalls[0].entityId, "ws_test_entity");
  assert.deepEqual(executedCalls[0].args, { customer: "cus_123", amount: 2500 });
  assert.deepEqual(executedCalls[0].opts, { version: "20260901_00" });
  assert.equal(result.tool, "STRIPE_CREATE_CHARGE");
  assert.equal(result.successful, true);
});


