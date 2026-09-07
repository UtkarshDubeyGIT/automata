import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { NextRequest } from "next/server";

let mockSession: { supabase: unknown; userId: string | null; workspaceId: string | null; entityId: string | null } = {
  supabase: null,
  userId: null,
  workspaceId: null,
  entityId: null,
};

mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => mockSession,
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    listToolsForToolkit: async () => [
      {
        slug: "STRIPE_CREATE_CHARGE",
        spec: {
          app: "stripe",
          kind: "write",
          external: true,
          required: ["customer"],
          desc: "Create charge",
          argHint: '{"customer":""}',
        },
      },
    ],
    searchDynamicTools: async () => [],
  },
});

test("GET /api/integrations/catalog/tools requires authentication", async () => {
  mockSession = { supabase: null, userId: null, workspaceId: null, entityId: null };

  const { GET } = await import("@/app/api/integrations/catalog/tools/route");
  const req = new NextRequest("http://localhost:3000/api/integrations/catalog/tools?toolkit=github");
  const res = await GET(req);

  assert.equal(res.status, 401);
});

test("GET /api/integrations/catalog/tools returns tool definitions for a toolkit", async () => {
  mockSession = {
    supabase: {},
    userId: "usr_123",
    workspaceId: "ws_123",
    entityId: "ws_123",
  };

  const { GET } = await import("@/app/api/integrations/catalog/tools/route");
  const req = new NextRequest("http://localhost:3000/api/integrations/catalog/tools?toolkit=stripe");
  const res = await GET(req);

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.tools.length, 1);
  assert.equal(json.tools[0].slug, "STRIPE_CREATE_CHARGE");
  assert.equal(json.tools[0].spec.app, "stripe");
});
