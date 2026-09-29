import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
mock.module("@/lib/env", { namedExports: { supabaseConfigured: true } });
mock.module("@/lib/workspace", { namedExports: {
  resolveRequestContext: async () => ({ workspaceId: "workspace-1", userId: "owner-1", supabase: db }),
  getWorkspaceContext: async () => ({ plan: "free", credits: 1000, demo: true }),
} });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 8500 } });
mock.module("@/lib/billing/stripe", { namedExports: { stripeClient: () => null } });
const route = await import("@/app/api/billing/route");

test("complimentary Pro appears in access history and paginated workflow charges reconcile", async () => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 20 * 86_400_000).toISOString();
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "owner-1", role: "owner", joined_at: "2026-01-01" }]);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro", subscription_status: "invite_active" }]);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", plan: "pro", status: "invite_active", stripe_customer_id: null }]);
  db.replace("pro_access_requests", [{
    id: "grant-1", workspace_id: "workspace-1", status: "approved", email_status: "sent",
    requested_at: now.toISOString(), decided_at: now.toISOString(), access_expires_at: expiresAt,
    expired_at: null,
  }]);
  db.replace("credit_ledger", [
    ...Array.from({ length: 1001 }, (_, i) => ({
      id: i + 1, workspace_id: "workspace-1", reason: "workflow_run", delta: -2,
      ref: "workflow-1", created_at: now.toISOString(),
    })),
    { id: 1002, workspace_id: "workspace-1", reason: "workflow_build", delta: -3,
      ref: "workflow_build:build-1", created_at: now.toISOString() },
    { id: 1003, workspace_id: "other-workspace", reason: "video_ugc", delta: -999,
      created_at: now.toISOString() },
  ]);
  db.replace("workflow_runs", []);
  db.replace("workflows", [{ id: "workflow-1", workspace_id: "workspace-1", name: "Daily report" }]);

  const response = await route.GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan, "pro");
  assert.equal(body.billingSource, "courtesy");
  assert.equal(body.status, "active");
  assert.match(body.renewalText, /Complimentary Pro access ends/);
  assert.equal(body.proAccess.courtesyExpiresAt, expiresAt);
  assert.deepEqual(body.history, [{
    kind: "access", id: "grant-1", date: now.toISOString(), expiresAt,
    status: "Active", plan: "Pro", amount: "Complimentary · $0 charged",
  }]);
  assert.equal(body.spend.total, 2005);
  assert.equal(body.spend.workflows[0].name, "Daily report");
  assert.equal(body.spend.workflows[0].credits, 2002);
  assert.equal(body.spend.standalone[0].credits, 3);
  assert.equal(body.spend.workflows[0].credits + body.spend.standalone[0].credits, body.spend.total);
});

test("expired courtesy access and a paid takeover have distinct history states", async () => {
  const now = new Date();
  const expiredAt = new Date(now.getTime() - 86_400_000).toISOString();
  const decidedAt = new Date(now.getTime() - 31 * 86_400_000).toISOString();
  db.replace("pro_access_requests", [{
    id: "grant-1", workspace_id: "workspace-1", status: "approved", requested_at: decidedAt,
    decided_at: decidedAt, access_expires_at: expiredAt, expired_at: null,
  }]);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro", subscription_status: "invite_active" }]);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", plan: "pro", status: "invite_active" }]);
  db.replace("credit_ledger", []);
  const expired = await (await route.GET()).json();
  assert.equal(expired.billingSource, "courtesy");
  assert.equal(expired.status, "inactive");
  assert.match(expired.renewalText, /access ended/);
  assert.equal(expired.history[0].status, "Expired");

  const future = new Date(now.getTime() + 10 * 86_400_000).toISOString();
  db.replace("pro_access_requests", [{
    id: "grant-1", workspace_id: "workspace-1", status: "approved", requested_at: decidedAt,
    decided_at: decidedAt, access_expires_at: future, expired_at: null,
  }]);
  db.replace("workspaces", [{ id: "workspace-1", plan: "pro", subscription_status: "active", stripe_subscription_id: "sub_new" }]);
  db.replace("billing_customers", [{ workspace_id: "workspace-1", plan: "pro", status: "active" }]);
  const paid = await (await route.GET()).json();
  assert.equal(paid.billingSource, "stripe");
  assert.equal(paid.proAccess.courtesyExpiresAt, null);
  assert.equal(paid.history[0].status, "Ended");
});
