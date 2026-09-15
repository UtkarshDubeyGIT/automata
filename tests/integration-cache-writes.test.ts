import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import type { RequestContext } from "@/lib/workspace";

const writes: Array<{ kind: string; value: unknown }> = [];
const filters: Array<[string, unknown]> = [];
let adminCalls = 0;
const admin = {
  from(table: string) {
    assert.equal(table, "integrations");
    const query = {
      upsert: async (value: unknown) => { writes.push({ kind: "upsert", value }); return { error: null }; },
      update: (value: unknown) => { writes.push({ kind: "update", value }); return query; },
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      in: () => query,
      not: (key: string, _operator: string, value: unknown) => { filters.push([key, value]); return Promise.resolve({ error: null }); },
    };
    return query;
  },
};
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => { adminCalls++; return admin; } } });

const inCalls: Array<[string, unknown]> = [];
const readonly = {
  from() {
    const query = {
      upsert: async () => ({ error: { message: "permission denied for integrations" } }),
      update: () => query,
      select: () => query,
      eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
      in: (key: string, value: unknown) => {
        inCalls.push([key, value]);
        return Object.assign(Promise.resolve({ data: [
          { platform: "googlebusinessprofile", status: "connected", connected_account_id: "workspace-1" },
          { platform: "slack", status: "connected", connected_account_id: null },
          { platform: "gmail", status: "disconnected", connected_account_id: null },
        ] }), query);
      },
      not: async () => ({ error: { message: "permission denied for integrations" } }),
    };
    return query;
  },
};
const ctx = { supabase: readonly, userId: "user-1", workspaceId: "workspace-1", entityId: "workspace-1" } as unknown as RequestContext;
const { persistIntegration, syncConnections, readCachedIntegrations } = await import("@/lib/social/integrations-store");

test("verified OAuth state persists even when browser access to the cache is read-only", async () => {
  writes.length = 0;
  await persistIntegration(ctx, "googlebusinessprofile", "connected", "workspace-1");
  assert.deepEqual(writes, [{ kind: "upsert", value: {
    workspace_id: "workspace-1", platform: "googlebusinessprofile", status: "connected", connected_account_id: "workspace-1",
  } }]);
});

test("live reconciliation uses the server writer and retains native connections", async () => {
  writes.length = 0;
  filters.length = 0;
  await syncConnections(ctx, [{ platform: "slack", status: "connected", accountId: "ca-1" }]);
  assert.equal(writes.length, 2);
  assert.deepEqual(filters.find(([key]) => key === "workspace_id"), ["workspace_id", "workspace-1"]);
  assert.match(String(filters.find(([key]) => key === "platform")?.[1]), /googlebusinessprofile/);
});

test("live reconciliation persists a disconnected entry with no account id", async () => {
  writes.length = 0;
  await syncConnections(ctx, [{ platform: "gmail", status: "disconnected", accountId: null }]);
  const upsert = writes.find((w) => w.kind === "upsert");
  assert.deepEqual(upsert, { kind: "upsert", value: [{
    workspace_id: "workspace-1", platform: "gmail", status: "disconnected", connected_account_id: null,
  }] });
});

test("unverified contexts never obtain an admin writer", async () => {
  adminCalls = 0;
  for (const context of [
    { ...ctx, userId: null },
    { ...ctx, workspaceId: null },
    { ...ctx, entityId: "different-workspace" },
  ]) {
    await persistIntegration(context, "slack", "connected", "ca-1");
    await syncConnections(context, []);
  }
  assert.equal(adminCalls, 0);
});

test("cache reads stay on the RLS client and reject phantom connected rows", async () => {
  adminCalls = 0;
  const rows = await readCachedIntegrations(ctx);
  // "slack" is dropped: connected with no connected_account_id is the phantom
  // row this filter exists to reject. "gmail" survives even though it also
  // has no account id, because disconnected never claims to be live.
  assert.deepEqual(rows.map((row) => row.platform), ["googlebusinessprofile", "gmail"]);
  assert.equal(adminCalls, 0);
});

test("a broken connection is fetched from the cache, not silently dropped", async () => {
  const rows = await readCachedIntegrations(ctx);
  const gmail = rows.find((row) => row.platform === "gmail");
  assert.deepEqual(gmail, { platform: "gmail", status: "disconnected", connected_account_id: null });
  assert.deepEqual(inCalls.at(-1), ["status", ["connected", "pending", "disconnected"]]);
});
