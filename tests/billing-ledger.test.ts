import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
let event: Record<string, unknown>;
process.env.STRIPE_WEBHOOK_SECRET = "test-webhook-secret";
mock.module("@/lib/billing/stripe", { namedExports: { stripeClient: () => ({ webhooks: { constructEvent: () => event } }), planForPrice: (price: string) => price === "price_team" ? "team" : price === "price_pro" ? "pro" : null } });
mock.module("@/lib/supabase/admin", { namedExports: { createSupabaseAdminClient: () => db } });
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => db } });
const { POST } = await import("@/app/api/billing/webhook/route");
const { getBalance } = await import("@/lib/credits");
function request() { return new NextRequest("http://localhost/api/billing/webhook", { method: "POST", headers: { "stripe-signature": "test-signature" }, body: "{}" }); }

test("a paid subscription invoice grants usable workflow credits only once, including distinct duplicate events", async () => {
  db.replace("credit_ledger", []);
  db.replace("billing_events", []);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", stripe_customer_id: "cus_owned", plan: "pro" }]);
  event = { id: "evt_paid_1", type: "invoice.paid", data: { object: { id: "in_paid", customer: "cus_owned", billing_reason: "subscription_cycle" } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(await getBalance("workspace-1"), 10_000);
  event = { ...event, id: "evt_paid_2" };
  assert.equal((await POST(request())).status, 200);
  assert.equal(await getBalance("workspace-1"), 10_000);
});

test("subscription metadata changes never manufacture another monthly credit grant", async () => {
  db.replace("credit_ledger", []);
  db.replace("billing_events", []);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro" }]);
  event = { id: "evt_updated", type: "customer.subscription.updated", data: { object: {
    id: "sub_owned", customer: "cus_owned", status: "active", metadata: { workspace_id: "workspace-1", plan: "pro" }, items: { data: [{ price: { id: "price_pro" } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(await getBalance("workspace-1"), 0);
});

test("renewal credits follow the invoiced plan after a portal upgrade with stale checkout metadata", async () => {
  db.replace("credit_ledger", []);
  db.replace("billing_events", []);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", stripe_customer_id: "cus_owned", plan: "pro" }]);
  event = { id: "evt_upgraded_invoice", type: "invoice.paid", data: { object: {
    id: "in_team", customer: "cus_owned", billing_reason: "subscription_cycle",
    parent: { subscription_details: { metadata: { workspace_id: "workspace-1", plan: "pro" } } },
    lines: { data: [{ pricing: { price_details: { price: "price_team" } } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(await getBalance("workspace-1"), 40_000);
});
