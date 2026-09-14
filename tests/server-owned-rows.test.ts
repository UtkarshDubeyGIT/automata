import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let connected = false;
let statusThrows = false;
mock.module("@/lib/env", {
  namedExports: { firecrawlConfigured: true, googleBusinessConfigured: true },
});
mock.module("@/lib/integrations/vikunja-connection", {
  namedExports: {
    vikunjaStatus: async (workspaceId: string) => {
      if (statusThrows) throw new Error("store down");
      assert.equal(workspaceId, "workspace-1");
      return { connected, instanceUrl: connected ? "https://vikunja.example.com" : "", lastTestedAt: null, lastTestStatus: null };
    },
  },
});

const { serverOwnedRows } = await import("@/lib/integrations/server-owned-rows");
const { connectionsOf, unconnected } = await import("@/lib/workflows/apps");

const vikunjaApp = { app: "vikunja", label: "Vikunja", simulated: false };

test("a stored Vikunja token makes the publish gate pass with no Composio rows", async () => {
  connected = true;
  const rows = await serverOwnedRows({ workspaceId: "workspace-1" });
  assert.deepEqual(rows.find((r) => r.platform === "vikunja"), {
    platform: "vikunja",
    status: "connected",
    instanceUrl: "https://vikunja.example.com",
  });
  assert.deepEqual(unconnected(connectionsOf([vikunjaApp], rows, true)), []);
});

test("no Vikunja token still names Vikunja as the missing account", async () => {
  connected = false;
  const rows = await serverOwnedRows({ workspaceId: "workspace-1" });
  assert.deepEqual(unconnected(connectionsOf([vikunjaApp], rows, true)).map((c) => c.app), ["vikunja"]);
});

test("rows include firecrawl and Business Profile from the cache", async () => {
  connected = true;
  const rows = await serverOwnedRows({ workspaceId: "workspace-1" }, [
    { platform: "googlebusinessprofile", status: "connected" },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.platform, r.status]),
    [["firecrawl", "connected"], ["vikunja", "connected"], ["googlebusinessprofile", "connected"]],
  );
});

test("a credential store failure fails open to none rather than throwing", async () => {
  statusThrows = true;
  const rows = await serverOwnedRows({ workspaceId: "workspace-1" });
  assert.equal(rows.find((r) => r.platform === "vikunja")?.status, "none");
  statusThrows = false;
});

test("no workspace means nothing is connected", async () => {
  const rows = await serverOwnedRows({ workspaceId: null });
  assert.equal(rows.find((r) => r.platform === "vikunja")?.status, "none");
});
