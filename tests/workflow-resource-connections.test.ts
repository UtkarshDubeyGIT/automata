import assert from "node:assert/strict";
import test from "node:test";
import { connectedAccountIds } from "@/lib/social/composio-proxy";

test("resource lookup can detect multiple active accounts for one workspace", async () => {
  const seen: string[] = [];
  const fetcher = async (url: string | URL | Request) => {
    seen.push(String(url));
    return Response.json({ items: [
      { id: "one", status: "ACTIVE", toolkit: { slug: "slack" } },
      { id: "two", status: "ACTIVE", toolkit: { slug: "slack" } },
      { id: "other", status: "ACTIVE", toolkit: { slug: "github" } },
      { id: "pending", status: "PENDING", toolkit: { slug: "slack" } },
    ] });
  };
  assert.deepEqual(await connectedAccountIds("workspace-7", "slack", fetcher as typeof fetch, true), ["one", "two"]);
  assert.match(seen[0], /user_ids=workspace-7/);
});

test("connection lookup failure stays a failure in strict picker mode", async () => {
  const fetcher = async () => new Response("", { status: 503 });
  await assert.rejects(connectedAccountIds("workspace-7", "slack", fetcher as typeof fetch, true), /Could not check/);
});
