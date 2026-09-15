import type { User } from "@supabase/supabase-js";

/**
 * The minimal shape this needs out of a Supabase client — matched by both the
 * real client and the in-memory `FakeDb` used in tests.
 */
interface ProfilesTable {
  from(table: "profiles"): {
    update(payload: Record<string, string>): {
      eq(column: "id", value: string): PromiseLike<unknown>;
    };
  };
}

/**
 * The read half, kept off `ProfilesTable` deliberately.
 *
 * Adding a `select` branch to the interface above makes TypeScript give up
 * structurally matching the real Supabase client at the call site in
 * src/app/auth/callback/route.ts — "type instantiation is excessively deep".
 * Narrowing it here instead keeps that signature exactly as it was and confines
 * the looseness to the one statement that needs it.
 */
interface ProfilesReader {
  from(table: "profiles"): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<{ data: unknown }>;
      };
    };
  };
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * `private.handle_new_user()` only fires once, on `auth.users` insert, so a
 * Google photo or display name changed after signup never reaches `profiles`
 * on its own. This refreshes it on every Google login instead. Non-Google
 * users (only an `email` identity, or none) are a no-op. A field Google
 * reports empty this time is left alone rather than blanking out what's
 * already on file.
 *
 * The two fields are NOT treated alike. `avatar_url` is refreshed on every
 * login, because nothing in the product writes a competing value. `full_name`
 * is only filled when nothing is on file: the first-run flow invites the user
 * to correct the name Google supplied, and re-syncing would silently revert
 * that edit the next time they signed in. Same decision-versus-observation
 * split the brand profile already makes. Users who predate this sync still get
 * backfilled, because a missing name is exactly the empty case.
 *
 * `identities[].identity_data` is the primary source — GoTrue refreshes it on
 * every OAuth sign-in, which is what makes "refresh" mean more than
 * "first-login-only". `app_metadata.provider` + `user_metadata` is a fallback
 * for response shapes that omit `identities` (e.g. some session-derived
 * `User` objects); it is not the preferred path because `user_metadata` isn't
 * guaranteed to be re-synced on every login the way `identity_data` is.
 */
export async function syncGoogleProfile(supabase: ProfilesTable, user: User): Promise<void> {
  const google = user.identities?.find((identity) => identity.provider === "google");
  const isGoogleUser = user.identities ? Boolean(google) : user.app_metadata?.provider === "google";
  if (!isGoogleUser) return;

  const data: Record<string, unknown> = { ...user.user_metadata, ...google?.identity_data };
  const fullName = nonEmpty(data.full_name) ?? nonEmpty(data.name);
  const avatarUrl = nonEmpty(data.avatar_url) ?? nonEmpty(data.picture);

  const updates: Record<string, string> = {};
  if (avatarUrl) updates.avatar_url = avatarUrl;
  if (fullName) {
    const reader = supabase as unknown as ProfilesReader;
    const { data } = await reader.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const onFile = (data as { full_name?: unknown } | null)?.full_name;
    if (!nonEmpty(onFile)) updates.full_name = fullName;
  }
  if (Object.keys(updates).length === 0) return;

  await supabase.from("profiles").update(updates).eq("id", user.id);
}
