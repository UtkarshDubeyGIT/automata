import { strict as assert } from "node:assert";
import { test } from "node:test";
import { POST } from "@/app/hooks/[token]/route";
import { NextRequest } from "next/server";

test("POST /hooks/[token] returns 404 for invalid token format without delimiter", async () => {
  const req = new NextRequest("http://localhost:3000/hooks/invalidtoken", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  const res = await POST(req, { params: Promise.resolve({ token: "invalidtoken" }) });
  assert.equal(res.status, 404);
});

test("POST /hooks/[token] returns 404 for non-existent workflow", async () => {
  const req = new NextRequest("http://localhost:3000/hooks/nonexistent_id.secret_key", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  const res = await POST(req, {
    params: Promise.resolve({ token: "nonexistent_id.secret_key" }),
  });
  assert.equal(res.status, 404);
});
