import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let workspaceId: string | null = "workspace-1";
let tokenSeen = "";
let instanceUrlSeen = "";
let disconnected = false;
mock.module("@/lib/workspace", {
  namedExports: { resolveRequestContext: async () => ({ workspaceId, entityId: workspaceId }) },
});
mock.module("@/lib/integrations/vikunja-connection", {
  namedExports: {
    connectVikunja: async (_workspace: string, instanceUrl: string, token: string) => {
      instanceUrlSeen = instanceUrl;
      tokenSeen = token;
      return { connected: true, projectCount: 2, lastTestedAt: "now" };
    },
    vikunjaStatus: async () => ({ connected: true, instanceUrl: "https://vikunja.doubtbuddy.com", lastTestedAt: "now", lastTestStatus: "connected" }),
    disconnectVikunja: async () => { disconnected = true; },
    listVikunjaProjects: async () => [{ id: 21, title: "Operations" }],
  },
});

const route = await import("@/app/api/integrations/vikunja/route");

test("Vikunja route requires a workspace", async () => {
  workspaceId = null;
  const response = await route.GET();
  assert.equal(response.status, 401);
  workspaceId = "workspace-1";
});

test("Vikunja route connects with a pasted token", async () => {
  tokenSeen = "";
  instanceUrlSeen = "";
  const response = await route.POST(new Request("http://localhost/api/integrations/vikunja", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instanceUrl: "https://tasks.example.com", token: "user-token" }),
  }));
  assert.equal(response.status, 200);
  assert.equal(tokenSeen, "user-token");
  assert.equal(instanceUrlSeen, "https://tasks.example.com");
  assert.equal((await response.json()).connected, true);
});

test("Vikunja route lists safe project metadata", async () => {
  const response = await route.GET(new Request("http://localhost/api/integrations/vikunja?projects=1"));
  assert.deepEqual((await response.json()).projects, [{ id: 21, title: "Operations" }]);
});

test("Vikunja route disconnects the workspace", async () => {
  disconnected = false;
  const response = await route.DELETE();
  assert.equal(response.status, 200);
  assert.equal(disconnected, true);
});
