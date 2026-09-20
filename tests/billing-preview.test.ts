import assert from "node:assert/strict";
import { mock, test } from "node:test";

let contextReads = 0;
mock.module("@/lib/env", { namedExports: { supabaseConfigured: false } });
mock.module("@/lib/workspace", { namedExports: {
  resolveRequestContext: async () => ({ workspaceId: null }),
  getWorkspaceContext: async () => { contextReads++; return { plan: "team", credits: 123, demo: true }; },
} });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 0, priceBook: () => [] } });
mock.module("@/lib/billing/stripe", { namedExports: { stripeClient: () => null } });
const credits = await import("@/app/api/credits/route");
const billing = await import("@/app/api/billing/route");

test("preview billing and credits share the shell's workspace context without fictional invoices", async () => {
  const balance = await (await credits.GET()).json();
  const summary = await (await billing.GET()).json();
  assert.equal(balance.plan, "pro");
  assert.equal(summary.plan, balance.plan);
  assert.equal(balance.credits, 123);
  assert.equal(summary.credits, balance.credits);
  assert.equal(balance.demo, true);
  assert.equal(summary.demo, true);
  assert.deepEqual(summary.invoices, []);
  assert.equal(summary.currentPeriodEnd, null);
  assert.equal(contextReads, 2);
});
