import assert from "node:assert/strict";
import { test } from "node:test";
import type { User } from "@supabase/supabase-js";
import { FakeDb } from "./helpers/fake-supabase";
import { syncGoogleProfile } from "@/lib/auth/profile-sync";

/**
 * The `on_auth_user_created` trigger only fires once, at signup, so a
 * changed Google photo or display name never reaches `profiles` again on its
 * own. This is the app-side refresh that runs on every Google login instead.
 */

function googleUser(overrides: { id?: string; identity_data?: Record<string, unknown> } = {}): User {
  const id = overrides.id ?? "user-1";
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
        identity_data: {
          full_name: "Ada Lovelace",
          avatar_url: "https://lh3.googleusercontent.com/a/ada",
          ...overrides.identity_data,
        },
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
      {
        id: "identity-2",
        user_id: id,
        identity_id: "identity-2",
        provider: "email",
        identity_data: { email: "grace@example.com" },
      },
    ],
  } as User;
}

test("a Google login refreshes a stale name and photo", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-1", full_name: "Old Name", avatar_url: "https://old.example/a.png" });

  await syncGoogleProfile(db, googleUser());

  const [profile] = db.table("profiles");
  assert.equal(profile.full_name, "Ada Lovelace");
  assert.equal(profile.avatar_url, "https://lh3.googleusercontent.com/a/ada");
});

test("an empty field from Google never blanks an existing value", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-1", full_name: "Old Name", avatar_url: "https://old.example/a.png" });

  await syncGoogleProfile(db, googleUser({ identity_data: { avatar_url: "" } }));

  const [profile] = db.table("profiles");
  assert.equal(profile.full_name, "Ada Lovelace", "name still refreshes");
  assert.equal(profile.avatar_url, "https://old.example/a.png", "photo is left alone, not nulled out");
});

test("falls back to the name/picture keys some Google tokens use instead", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-1", full_name: null, avatar_url: null });

  await syncGoogleProfile(
    db,
    googleUser({
      identity_data: {
        full_name: undefined,
        avatar_url: undefined,
        name: "Ada L.",
        picture: "https://lh3.googleusercontent.com/a/fallback",
      },
    }),
  );

  const [profile] = db.table("profiles");
  assert.equal(profile.full_name, "Ada L.");
  assert.equal(profile.avatar_url, "https://lh3.googleusercontent.com/a/fallback");
});

test("email/password users are left completely untouched", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-2", full_name: "Grace Hopper", avatar_url: null });

  await syncGoogleProfile(db, emailUser());

  assert.deepEqual(db.table("profiles"), [{ id: "user-2", full_name: "Grace Hopper", avatar_url: null }]);
});

test("falls back to app_metadata/user_metadata when a response shape omits identities", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-4", full_name: "Old", avatar_url: null });
  const user = {
    id: "user-4",
    aud: "authenticated",
    created_at: new Date().toISOString(),
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: { full_name: "Ada Lovelace", avatar_url: "https://lh3.googleusercontent.com/a/ada" },
  } as User;

  await syncGoogleProfile(db, user);

  const [profile] = db.table("profiles");
  assert.equal(profile.full_name, "Ada Lovelace");
  assert.equal(profile.avatar_url, "https://lh3.googleusercontent.com/a/ada");
});

test("the fallback path also leaves email/password users alone", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-5", full_name: "Grace Hopper", avatar_url: null });
  const user = {
    id: "user-5",
    aud: "authenticated",
    created_at: new Date().toISOString(),
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: "Should not land" },
  } as User;

  await syncGoogleProfile(db, user);

  assert.deepEqual(db.table("profiles"), [{ id: "user-5", full_name: "Grace Hopper", avatar_url: null }]);
});

test("a user with no identities at all is a no-op, not a throw", async () => {
  const db = new FakeDb();
  db.seed("profiles", { id: "user-3", full_name: "No Identity", avatar_url: null });
  const bare = { id: "user-3", app_metadata: {}, user_metadata: {} } as User;

  await syncGoogleProfile(db, bare);

  assert.deepEqual(db.table("profiles"), [{ id: "user-3", full_name: "No Identity", avatar_url: null }]);
});
