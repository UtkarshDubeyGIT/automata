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
  if (fullName) updates.full_name = fullName;
  if (avatarUrl) updates.avatar_url = avatarUrl;
  if (Object.keys(updates).length === 0) return;

  await supabase.from("profiles").update(updates).eq("id", user.id);
}
