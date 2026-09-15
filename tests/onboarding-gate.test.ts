import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  auth: { getUser: async () => ({ data: { user: { id: "user-1", email: "ada@example.com" } } }) },
});
mock.module("@/lib/env", { namedExports: { supabaseConfigured: true } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => db } });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 0 } });

const { shouldOnboard } = await import("@/lib/onboarding/gate");
const { getWorkspaceContext } = await import("@/lib/workspace");
type WorkspaceContext = Awaited<ReturnType<typeof getWorkspaceContext>>;

function context(over: Partial<WorkspaceContext>): WorkspaceContext {
  return {
    userName: "Ada",
    userEmail: "ada@example.com",
    userAvatarUrl: null,
    workspaceId: "workspace-1",
    workspaceName: "Ada's workspace",
    workspaceCreatedAt: null,
    plan: "free",
    credits: 0,
    onboarded: false,
    demo: false,
    ...over,
  };
}

function seed(workspace: Record<string, unknown>) {
  db.replace("workspaces", [{ id: "workspace-1", created_by: "user-1", name: "Ada's workspace", plan: "free", ...workspace }]);
  db.replace("workspace_members", [{ workspace_id: "workspace-1", user_id: "user-1", joined_at: "2026-01-01T00:00:00Z" }]);
  db.replace("profiles", [{ id: "user-1", full_name: "Ada Lovelace", avatar_url: null }]);
}

test("a workspace that has never been set up goes to onboarding", () => {
  assert.equal(shouldOnboard(context({ onboarded: false })), true);
});

test("a workspace that finished or skipped setup is left alone", () => {
  assert.equal(shouldOnboard(context({ onboarded: true })), false);
});

test("demo mode never onboards", () => {
  // getWorkspaceContext falls back to DEMO when Supabase is unreachable, so
  // treating demo as un-onboarded would trap real users behind a transient
  // database error.
  assert.equal(shouldOnboard(context({ demo: true, onboarded: false })), false);
});

test("a user with no resolvable workspace is not trapped in the flow", () => {
  // Nothing to write the answers to, so sending them through the steps would
  // discard every one of them at the end.
  assert.equal(shouldOnboard(context({ workspaceId: null, onboarded: false })), false);
});

test("a stored onboarded flag of false reaches the gate", async () => {
  seed({ onboarded: false });

  const ctx = await getWorkspaceContext();

  assert.equal(ctx.onboarded, false);
  assert.equal(shouldOnboard(ctx), true);
});

test("a database with no onboarded value fails open rather than replaying setup", async () => {
  // Zidane-baseline rows predate the column. Reading `undefined` must not read
  // as "never onboarded" for a workspace that has been in use for months.
  seed({});

  const ctx = await getWorkspaceContext();

  assert.equal(ctx.onboarded, true);
  assert.equal(shouldOnboard(ctx), false);
});
