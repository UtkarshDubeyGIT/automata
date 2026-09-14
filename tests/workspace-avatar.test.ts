import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "ada@example.com" } } }) },
});
mock.module("@/lib/env", { namedExports: { supabaseConfigured: true } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 42 } });
const { getWorkspaceContext } = await import("@/lib/workspace");

test("the app shell reads the synced Google photo back out of the profile", async () => {
  db.replace("workspaces", [{ id: "workspace-1", created_by: "user-1", name: "Ada's workspace", plan: "free" }]);
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "user-1" }]);
  db.replace("profiles", [
    { id: "user-1", full_name: "Ada Lovelace", avatar_url: "https://lh3.googleusercontent.com/a/ada" },
  ]);

  const ctx = await getWorkspaceContext();

  assert.equal(ctx.userAvatarUrl, "https://lh3.googleusercontent.com/a/ada");
});

test("a user with no photo on file gets null, not a broken image", async () => {
  db.replace("workspaces", [{ id: "workspace-1", created_by: "user-1", name: "Ada's workspace", plan: "free" }]);
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "user-1" }]);
  db.replace("profiles", [{ id: "user-1", full_name: "Ada Lovelace", avatar_url: null }]);

  const ctx = await getWorkspaceContext();

  assert.equal(ctx.userAvatarUrl, null);
});
