import assert from "node:assert/strict";
import { mock, test } from "node:test";

const prices = [{ reason: "workflow_build", label: "Workflow build", credits: 3 }];
mock.module("@/lib/env", { namedExports: { supabaseConfigured: true } });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 75, priceBook: () => prices } });
mock.module("@/lib/workspace", { namedExports: { resolveRequestContext: async () => ({ workspaceId: "workspace-1", supabase: null }), getWorkspaceContext: async () => ({ plan: "pro", credits: 2500, demo: true }) } });
mock.module("@/lib/billing/stripe", { namedExports: { stripeClient: () => null } });

async function route(path: string) {
  try { return await import(path) as { GET: () => Promise<Response> }; }
  catch (error) {
    if (String(error).includes("Cannot resolve") || String(error).includes("Cannot find module")) return null;
    throw error;
  }
}

test("the credits endpoint returns the live workspace balance with workflow prices", async () => {
  const api = await route("@/app/api/credits/route");
  assert.ok(api, "The app shell needs a credits route");
  const response = await api.GET();
  const body = await response.json();
  assert.equal(body.credits, 75);
  assert.deepEqual(body.prices, prices);
});

test("the billing endpoint returns the same live balance when Stripe is unavailable", async () => {
  const api = await route("@/app/api/billing/route");
  assert.ok(api, "The billing screen needs a billing summary route");
  const response = await api.GET();
  const body = await response.json();
  assert.equal(body.credits, 75);
  assert.equal(body.hasCustomerPortal, false);
  assert.deepEqual(body.invoices, []);
  assert.deepEqual(body.spend, { periodLabel: "Last 30 days", total: 0, refunded: 0, categories: [] });
});
