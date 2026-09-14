import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { User } from "@supabase/supabase-js";
import { FakeDb } from "./helpers/fake-supabase";

/**
 * `/auth/callback` is shared by two flows: Google's OAuth redirect and the
 * email-confirmation link Supabase mails out on signup. The profile sync must
 * only fire for the former — an email/password user has no Google identity to
 * read a photo or name from.
 */

mock.module("@/lib/env", {
  namedExports: { env: { appUrl: "https://automata.doubtbuddy.com" } },
});

const db = new FakeDb();
let exchange: { user: User | null; error: { code?: string; status?: number } | null } = {
  user: null,
  error: null,
};

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseClient: async () => ({
      auth: {
        exchangeCodeForSession: async () => ({
          data: { user: exchange.user, session: exchange.user ? { user: exchange.user } : null },
          error: exchange.error,
        }),
      },
      from: db.from.bind(db),
    }),
  },
});

const { GET } = await import("@/app/auth/callback/route");

function googleUser(id = "user-1"): User {
  return {
    id,
    aud: "authenticated",
    created_at: new Date().toISOString(),
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    identities: [
      {
        id: "identity-1",
        user_id: id,
        identity_id: "identity-1",
        provider: "google",
        identity_data: { full_name: "Ada Lovelace", avatar_url: "https://lh3.googleusercontent.com/a/ada" },
      },
    ],
  } as User;
}

function emailUser(id = "user-2"): User {
  return {
    id,
    aud: "authenticated",
    created_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    identities: [
      { id: "identity-2", user_id: id, identity_id: "identity-2", provider: "email", identity_data: {} },
    ],
  } as User;
}

function request(query: string) {
  return { nextUrl: new URL(`https://automata.doubtbuddy.com/auth/callback${query}`) } as never;
}

test("a successful Google callback refreshes the profile before redirecting", async () => {
  db.replace("profiles", [{ id: "user-1", full_name: "Old Name", avatar_url: "https://old.example/a.png" }]);
  exchange = { user: googleUser(), error: null };

  const res = await GET(request("?code=abc&next=%2Fapp%2Fworkflows"));

  assert.equal(res.headers.get("location"), "https://automata.doubtbuddy.com/app/workflows");
  const [profile] = db.table("profiles");
  assert.equal(profile.full_name, "Ada Lovelace");
  assert.equal(profile.avatar_url, "https://lh3.googleusercontent.com/a/ada");
});

test("an email/password callback (confirmation link) never touches profiles", async () => {
  db.replace("profiles", [{ id: "user-2", full_name: "Grace Hopper", avatar_url: null }]);
  exchange = { user: emailUser(), error: null };

  await GET(request("?code=abc"));

  assert.deepEqual(db.table("profiles"), [{ id: "user-2", full_name: "Grace Hopper", avatar_url: null }]);
});

test("a failed code exchange redirects to the failure page without syncing anything", async () => {
  db.replace("profiles", []);
  exchange = { user: null, error: { code: "bad_code", status: 400 } };

  const res = await GET(request("?code=abc"));

  assert.ok(res.headers.get("location")?.includes("verify_failed"));
  assert.deepEqual(db.table("profiles"), []);
});

test("a provider error on the redirect itself skips the exchange and profile sync entirely", async () => {
  db.replace("profiles", []);
  exchange = { user: googleUser(), error: null };

  const res = await GET(request("?error=access_denied&error_description=denied"));

  assert.ok(res.headers.get("location")?.includes("link_expired"));
  assert.deepEqual(db.table("profiles"), []);
});
