import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let stored: unknown = null;
mock.module("@/lib/credentials", {
  namedExports: {
    saveCredential: async (_workspaceId: string, provider: string, value: unknown) => {
      assert.equal(provider, "vikunja");
      stored = value;
    },
    readCredential: async () => stored,
    deleteCredential: async (_workspaceId: string, provider: string) => {
      assert.equal(provider, "vikunja");
      stored = null;
    },
  },
});

const connection = await import("@/lib/integrations/vikunja-connection");

test("connecting Vikunja verifies before storing and never returns the token", async () => {
  stored = null;
  let verified = false;
  const result = await connection.connectVikunja("workspace-1", "api-token", async () => {
    verified = true;
    return Response.json([{ id: 21, title: "Operations", max_permission: 1 }]);
  });

  assert.equal(verified, true);
  assert.equal(result.connected, true);
  assert.equal(result.projectCount, 1);
  assert.equal("token" in result, false);
  assert.deepEqual(stored, {
    token: "api-token",
    instanceUrl: "https://vikunja.doubtbuddy.com",
    lastTestedAt: result.lastTestedAt,
    lastTestStatus: "connected",
  });
});

test("failed verification stores nothing", async () => {
  stored = null;
  await assert.rejects(
    connection.connectVikunja("workspace-1", "bad-token", async () =>
      Response.json({ message: "Nope" }, { status: 401 }),
    ),
  );
  assert.equal(stored, null);
});

test("connection status exposes metadata but never credentials", async () => {
  stored = {
    token: "hidden",
    instanceUrl: "https://vikunja.doubtbuddy.com",
    lastTestedAt: "2026-09-12T12:00:00.000Z",
    lastTestStatus: "connected",
  };
  assert.deepEqual(await connection.vikunjaStatus("workspace-1"), {
    connected: true,
    instanceUrl: "https://vikunja.doubtbuddy.com",
    lastTestedAt: "2026-09-12T12:00:00.000Z",
    lastTestStatus: "connected",
  });
});

test("disconnect removes the workspace credential", async () => {
  stored = { token: "hidden" };
  await connection.disconnectVikunja("workspace-1");
  assert.equal(stored, null);
});
