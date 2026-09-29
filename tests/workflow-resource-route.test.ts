import assert from "node:assert/strict";
import { mock, test } from "node:test";

let context: { userId: string | null; workspaceId: string | null; entityId: string | null } = {
  userId: null, workspaceId: null, entityId: null,
};
const calls: Array<[string, string, string, string]> = [];
let failure: { message: string; status: number } | null = null;
mock.module("@/lib/workspace", { namedExports: { resolveRequestContext: async () => context } });
mock.module("@/lib/workflows/resource-server", { namedExports: {
  ResourceLookupError: class extends Error { status = 409; },
  listResourcePage: async (workspaceId: string, kind: string, cursor: string, parent: string) => {
    calls.push([workspaceId, kind, cursor, parent]);
    if (failure) throw Object.assign(new Error(failure.message), { status: failure.status });
    return { choices: [{ value: "C1", label: "#general" }], nextCursor: cursor ? null : "page-2" };
  },
} });

const { GET } = await import("@/app/api/integrations/resources/route");

test("resource lookup requires a verified workspace", async () => {
  calls.length = 0;
  const response = await GET(new Request("http://localhost/api/integrations/resources?kind=slack_channel"));
  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test("resource lookup rejects unknown kinds and scopes valid kinds", async () => {
  context = { userId: "user-1", workspaceId: "workspace-1", entityId: "workspace-1" };
  const bad = await GET(new Request("http://localhost/api/integrations/resources?kind=any_url"));
  assert.equal(bad.status, 400);
  const good = await GET(new Request("http://localhost/api/integrations/resources?kind=slack_channel"));
  assert.equal(good.status, 200);
  assert.deepEqual(calls, [["workspace-1", "slack_channel", "", ""]]);
});

test("cursor, parent and workspace are isolated in resource lookups", async () => {
  calls.length = 0;
  context = { userId: "user-2", workspaceId: "workspace-2", entityId: "workspace-2" };
  const first = await GET(new Request("http://localhost/api/integrations/resources?kind=linear_project&parent=team-7"));
  assert.equal(first.status, 200);
  assert.equal((await first.json()).nextCursor, "page-2");
  const second = await GET(new Request("http://localhost/api/integrations/resources?kind=linear_project&parent=team-7&cursor=page-2"));
  assert.equal((await second.json()).nextCursor, null);
  assert.deepEqual(calls, [
    ["workspace-2", "linear_project", "", "team-7"],
    ["workspace-2", "linear_project", "page-2", "team-7"],
  ]);
  const invalidParent = await GET(new Request("http://localhost/api/integrations/resources?kind=slack_channel&parent=team-7"));
  assert.equal(invalidParent.status, 400);
});

test("lookup errors are distinct from an empty resource list", async () => {
  context = { userId: "user-3", workspaceId: "workspace-3", entityId: "workspace-3" };
  failure = { message: "Provider unavailable", status: 502 };
  const response = await GET(new Request("http://localhost/api/integrations/resources?kind=ga4_property"));
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /Provider unavailable/);
  failure = null;
});
