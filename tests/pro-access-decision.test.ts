import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  rpc: async () => {
    calls++;
    return { data: { outcome: calls === 1 ? "approved" : "invalid", request_id: calls === 1 ? "request-1" : undefined }, error: null };
  },
});
let calls = 0;
let notices = 0;
mock.module("@/lib/supabase/admin", { namedExports: { createSupabaseAdminClient: () => db } });
mock.module("@/lib/billing/pro-access", { namedExports: {
  validReviewToken: (token: string) => token === "A".repeat(43),
  reviewTokenHash: () => "token-hash",
  notifyProAccessDecision: async () => { notices++; },
} });
const route = await import("@/app/api/billing/pro-access/decision/route");

function request(token: string, decision = "approved") {
  const form = new FormData();
  form.set("token", token);
  form.set("decision", decision);
  return new NextRequest("http://localhost/api/billing/pro-access/decision", { method: "POST", body: form });
}

test("a malformed or unexpected decision never reaches the database", async () => {
  calls = 0;
  notices = 0;
  assert.equal((await route.POST(request("bad"))).status, 303);
  assert.equal((await route.POST(request("A".repeat(43), "anything"))).status, 303);
  assert.equal(calls, 0);
  assert.equal(notices, 0);
});

test("the decision is submitted once and a replay does not notify again", async () => {
  calls = 0;
  notices = 0;
  db.replace("pro_access_requests", [{ id: "request-1", status: "approved" }]);
  const first = await route.POST(request("A".repeat(43)));
  const replay = await route.POST(request("A".repeat(43)));
  assert.equal(first.status, 303);
  assert.match(first.headers.get("location") ?? "", /outcome=approved/);
  assert.match(replay.headers.get("location") ?? "", /outcome=invalid/);
  assert.equal(calls, 2);
  assert.equal(notices, 1);
});
