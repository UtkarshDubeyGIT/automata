import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("@/lib/env", { namedExports: { supabaseConfigured: false } });
// Not exercised on the demo path, but `@/lib/workspace` imports these unconditionally.
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => null, createAdminClient: () => null } });
mock.module("@/lib/credits", { namedExports: { getBalance: async () => 0 } });
const { getWorkspaceContext } = await import("@/lib/workspace");

test("demo/preview mode has no photo to leak", async () => {
  const ctx = await getWorkspaceContext();
  assert.equal(ctx.userAvatarUrl, null);
});
