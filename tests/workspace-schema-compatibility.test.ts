import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "test@example.com" } } }) },
});
mock.module("@/lib/env", { namedExports: { supabaseConfigured: true } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 42 } });
const { resolveRequestContext, getWorkspaceContext } = await import("@/lib/workspace");

test("an existing Zidane owner resolves the same workspace for API calls and the app shell", async () => {
  db.replace("workspaces", [{ id: "legacy-workspace", owner_id: "user-1", name: "My studio", plan: "growth" }]);
  db.replace("workspace_members", []);
  assert.equal((await resolveRequestContext()).workspaceId, "legacy-workspace");
  const context = await getWorkspaceContext();
  assert.equal(context.workspaceId, "legacy-workspace");
  assert.equal(context.workspaceName, "My studio");
  assert.equal(context.credits, 42);
});

test("Automata membership remains the preferred workspace boundary", async () => {
  db.replace("workspace_members", [{ workspace_id: "shared-workspace", user_id: "user-1" }]);
  db.replace("workspaces", [
    { id: "shared-workspace", name: "Shared", plan: "team" },
    { id: "legacy-workspace", owner_id: "user-1" },
  ]);
  assert.equal((await resolveRequestContext()).workspaceId, "shared-workspace");
});
