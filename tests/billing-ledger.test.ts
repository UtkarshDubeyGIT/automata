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

test("a retired Team price grants the Pro allowance after the tier is removed", async () => {
  db.replace("credit_ledger", []);
  db.replace("billing_events", []);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", stripe_customer_id: "cus_owned", plan: "pro" }]);
  event = { id: "evt_upgraded_invoice", type: "invoice.paid", data: { object: {
    id: "in_team", customer: "cus_owned", billing_reason: "subscription_cycle",
    parent: { subscription_details: { metadata: { workspace_id: "workspace-1", plan: "pro" } } },
    lines: { data: [{ pricing: { price_details: { price: "price_team" } } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(await getBalance("workspace-1"), 10_000);
});

test("a delayed cancellation does not revoke courtesy Pro access", async () => {
  db.replace("billing_events", []);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro", subscription_status: "invite_active", stripe_subscription_id: "sub_old" }]);
  event = { id: "evt_old_cancel", type: "customer.subscription.deleted", data: { object: {
    id: "sub_old", customer: "cus_old", status: "canceled", metadata: { workspace_id: "workspace-1", plan: "pro" },
    items: { data: [{ price: { id: "price_pro" } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(db.table("workspaces")[0].plan, "pro");
  assert.equal(db.table("workspaces")[0].subscription_status, "invite_active");
  event = { id: "evt_old_active_late", type: "customer.subscription.updated", data: { object: {
    id: "sub_old", customer: "cus_old", status: "active", metadata: { workspace_id: "workspace-1", plan: "pro" },
    items: { data: [{ price: { id: "price_pro" } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(db.table("workspaces")[0].subscription_status, "invite_active");
});

test("a new paid subscription takes over courtesy access and ignores the old subscription", async () => {
  db.replace("billing_events", []);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro", subscription_status: "invite_active", stripe_subscription_id: "sub_old" }]);
  event = { id: "evt_new_paid", type: "customer.subscription.updated", data: { object: {
    id: "sub_new", customer: "cus_new", status: "active", metadata: { workspace_id: "workspace-1", plan: "pro" },
    items: { data: [{ price: { id: "price_pro" } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(db.table("workspaces")[0].subscription_status, "active");
  assert.equal(db.table("workspaces")[0].stripe_subscription_id, "sub_new");
  event = { id: "evt_old_cancel_late", type: "customer.subscription.deleted", data: { object: {
    id: "sub_old", customer: "cus_old", status: "canceled", metadata: { workspace_id: "workspace-1", plan: "pro" },
    items: { data: [{ price: { id: "price_pro" } }] },
  } } };
  assert.equal((await POST(request())).status, 200);
  assert.equal(db.table("workspaces")[0].subscription_status, "active");
  assert.equal(db.table("workspaces")[0].stripe_subscription_id, "sub_new");
});
