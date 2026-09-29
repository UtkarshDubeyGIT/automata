import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  auth: { getUser: async () => ({ data: { user: { id: "owner-1", email: "owner@example.com" } }, error: null }) },
});
let mailCount = 0;
let failEmail = false;
mock.module("@/lib/supabase/server", { namedExports: { createServerSupabaseClient: async () => db } });
mock.module("@/lib/supabase/admin", { namedExports: { createSupabaseAdminClient: () => db } });
mock.module("@/lib/billing/pro-access", { namedExports: {
  newReviewToken: () => "A".repeat(43),
  reviewTokenHash: (token: string) => `hash:${token}`,
  emailReviewer: async () => { mailCount++; if (failEmail) throw new Error("mail unavailable"); },
} });
const route = await import("@/app/api/billing/pro-access/request/route");

function request(workspaceId?: string) {
  return new NextRequest("http://localhost/api/billing/pro-access/request", {
    method: "POST", body: JSON.stringify(workspaceId ? { workspaceId } : {}),
  });
}

function seed() {
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "owner-1", role: "owner", joined_at: "2026-01-01" }]);
  db.replace("workspaces", [{ id: "workspace-1", name: "Studio", plan: "free" }]);
  db.replace("billing_customers", []);
  db.replace("pro_access_requests", []);
  mailCount = 0;
  failEmail = false;
}

test("an owner requests once and duplicate clicks do not send another email", async () => {
  seed();
  assert.equal((await route.POST(request())).status, 200);
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(db.table("pro_access_requests").length, 1);
  assert.equal(db.table("pro_access_requests")[0].requester_email, "owner@example.com");
  assert.equal(db.table("pro_access_requests")[0].email_status, "sent");
  assert.equal(mailCount, 1);
});

test("failed reviewer email can be retried without creating another request", async () => {
  seed();
  failEmail = true;
  assert.equal((await route.POST(request())).status, 502);
  assert.equal(db.table("pro_access_requests")[0].email_status, "failed");
  failEmail = false;
  assert.equal((await route.POST(request())).status, 200);
  assert.equal(db.table("pro_access_requests").length, 1);
  assert.equal(db.table("pro_access_requests")[0].email_status, "sent");
  assert.equal(mailCount, 2);
});

test("members without billing rights and users of another workspace cannot request Pro", async () => {
  seed();
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "owner-1", role: "viewer", joined_at: "2026-01-01" }]);
  assert.equal((await route.POST(request())).status, 403);
  seed();
  assert.equal((await route.POST(request("workspace-2"))).status, 403);
  assert.equal(mailCount, 0);
});

test("an existing Pro workspace cannot request another grant", async () => {
  seed();
  db.replace("workspaces", [{ id: "workspace-1", name: "Studio", plan: "pro" }]);
  assert.equal((await route.POST(request())).status, 409);
  assert.equal(db.table("pro_access_requests").length, 0);
});
