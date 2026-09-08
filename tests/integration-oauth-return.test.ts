import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

process.env.NEXT_PUBLIC_APP_URL = "https://zidaneai.com";
process.env.COMPOSIO_API_KEY = "test-composio-key";

let connectArgs: unknown[] = [];

mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => ({
      supabase: null,
      userId: "user-1",
      workspaceId: "workspace-1",
      entityId: "workspace-1",
    }),
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    normalizeSlug: (value: string) => value,
    SLUG_RE: /^[a-z0-9_-]+$/,
    hasOwnOAuthApp: () => false,
    PLATFORMS: [],
    socialProvider: {
      live: true,
      connect: async (...args: unknown[]) => {
        connectArgs = args;
        return { connected: false, redirectUrl: "https://backend.composio.dev/connect" };
      },
      listConnections: async () => [
        { platform: "google_sheets", status: "connected", accountId: "ca-1" },
      ],
    },
  },
});

mock.module("@/lib/social/integrations-store", {
  namedExports: {
    persistIntegration: async () => {},
    readCachedIntegrations: async () => [],
    syncConnections: async () => {},
  },
});

const { GET } = await import("@/app/api/integrations/callback/route");
const { POST: connect } = await import("@/app/api/integrations/connect/route");

test("a popup OAuth callback hands the result back without rendering a fresh workflow page", async () => {
  const req = {
    nextUrl: new URL(
      "https://zidaneai.com/api/integrations/callback?platform=google_sheets&return=%2Fworkflows&returnMode=popup",
    ),
  } as never;

  const res = await GET(req);
  const html = await res.text();

  assert.equal(res.status, 200);
  assert.equal(res.headers.get("location"), null);
  assert.match(html, /BroadcastChannel/);
  assert.match(html, /postMessage/);
  assert.match(html, /window\.close/);
  assert.match(html, /zidaneai:integration-return/);
  assert.match(html, /\/workflows/);
});

test("a workflow connection asks Composio for the popup callback handoff", async () => {
  connectArgs = [];
  const res = await connect(
    new Request("https://zidaneai.com/api/integrations/connect", {
      method: "POST",
      body: JSON.stringify({
        platform: "google_sheets",
        returnTo: "/workflows",
        returnMode: "popup",
      }),
    }),
  );

  assert.equal(res.status, 200);
  assert.match(String(connectArgs[2]), /returnMode=popup/);
});

test("a normal integration callback keeps its redirect behavior", async () => {
  const req = {
    nextUrl: new URL(
      "https://zidaneai.com/api/integrations/callback?platform=google_sheets&return=%2Fintegrations",
    ),
  } as never;

  const res = await GET(req);

  assert.equal(res.status, 307);
  assert.match(res.headers.get("location") ?? "", /\/integrations\?connected=google_sheets/);
});


test("connections started without a return path land in Automata integrations", async () => {
  connectArgs = [];
  const res = await connect(new Request("https://zidaneai.com/api/integrations/connect", {
    method: "POST",
    body: JSON.stringify({ platform: "google_sheets" }),
  }));
  assert.equal(res.status, 200);
  const callback = new URL(String(connectArgs[2]));
  assert.equal(callback.searchParams.get("return"), "/app/integrations");
});

test("a callback without a return path lands in Automata integrations", async () => {
  const res = await GET({ nextUrl: new URL("https://zidaneai.com/api/integrations/callback?platform=google_sheets") } as never);
  assert.equal(new URL(res.headers.get("location")!).pathname, "/app/integrations");
});
