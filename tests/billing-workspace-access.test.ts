import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), { auth: { getClaims: async () => ({ data: { claims: { sub: "owner-1", email: "owner@example.com" } } }) } });
const outbound: Record<string, unknown>[] = [];
const create = async (input: Record<string, unknown>) => { outbound.push(input); return { url: "https://billing.example.com/session" }; };
mock.module("@/lib/billing/stripe", { namedExports: {
  stripeClient: () => ({ checkout: { sessions: { create } }, billingPortal: { sessions: { create } } }),
  stripePrice: () => "price_pro",
} });
mock.module("@/lib/supabase/server", { namedExports: { createServerSupabaseClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createSupabaseAdminClient: () => db } });
const checkout = await import("@/app/api/billing/checkout/route");
const portal = await import("@/app/api/billing/portal/route");

function request(route: string, body: object) {
  return new NextRequest(`http://localhost/api/billing/${route}`, { method: "POST", body: JSON.stringify(body) });
}

test("legacy workspace owners can open their existing customer portal and select an Automata plan", async () => {
  db.replace("workspace_members", []);
  db.replace("workspaces", [{ id: "workspace-1", owner_id: "owner-1", name: "Studio" }]);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", stripe_customer_id: "cus_owned" }]);
  outbound.length = 0;
  assert.equal((await checkout.POST(request("checkout", { plan: "pro" }))).status, 200);
  assert.equal((await portal.POST(request("portal", {}))).status, 200);
  assert.equal(outbound[0].customer, "cus_owned");
  assert.equal(outbound[1].customer, "cus_owned");
});

test("a viewer or another workspace's owner cannot create a billing session", async () => {
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "owner-1", role: "viewer" }]);
  db.replace("workspaces", [{ id: "workspace-1", owner_id: "owner-1" }, { id: "workspace-2", owner_id: "different-user" }]);
  outbound.length = 0;
  assert.equal((await checkout.POST(request("checkout", { plan: "pro", workspaceId: "workspace-1" }))).status, 403);
  assert.equal((await portal.POST(request("portal", { workspaceId: "workspace-2" }))).status, 403);
  assert.equal(outbound.length, 0);
});

test("checkout refuses the retired Team plan", async () => {
  db.replace("workspace_members", []);
  db.replace("workspaces", [{ id: "workspace-1", owner_id: "owner-1", name: "Studio" }]);
  outbound.length = 0;
  assert.equal((await checkout.POST(request("checkout", { plan: "team" }))).status, 400);
  assert.equal(outbound.length, 0);
});
