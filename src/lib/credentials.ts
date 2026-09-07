import crypto from "node:crypto";
import { createAdminClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";

/**
 * Workspace-owned provider secrets, encrypted at rest.
 *
 * The table (`workspace_provider_credentials`, migration 20260903120000) and
 * the key (`CREDENTIAL_ENCRYPTION_KEY`) both shipped before anything used
 * them. This is the missing half.
 *
 * WHY THIS EXISTS AT ALL, GIVEN COMPOSIO. Every other provider's tokens live
 * inside Composio: we send a tool call or a proxy URL and never see a
 * credential. Google Business Profile has no Composio toolkit — verified
 * against the live catalog, all six plausible slugs 404 — so it is the one
 * integration where our server performs the OAuth handshake and therefore
 * holds a refresh token. A refresh token is long-lived and grants ongoing
 * write access to a real business's public reviews, which is why it is
 * encrypted rather than merely row-secured.
 *
 * The table has RLS on with NO policy, so PostgREST refuses it for every
 * ordinary session; only the service-role client used here can reach it. That
 * is deliberate defence in depth: even a full client-side compromise reaches
 * ciphertext at worst, and only if it has also stolen the service role key.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM's standard nonce length.

export const credentialsConfigured = /^[0-9a-fA-F]{64}$/.test(env.credentialKey);

function key(): Buffer {
  if (!credentialsConfigured) {
    // Failing loudly beats writing something we cannot read back. A silent
    // fallback key would encrypt tokens that are unrecoverable after the real
    // key is configured, and the failure would surface weeks later as an
    // integration that can no longer refresh.
    throw new Error(
      setupNotice(
        "Saved credentials are unavailable on this deployment.",
        "CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters (32 bytes).",
      ),
    );
  }
  return Buffer.from(env.credentialKey, "hex");
}

/** `iv.ciphertext.tag`, all base64url — one opaque column value. */
export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, enc, cipher.getAuthTag()].map((b) => b.toString("base64url")).join(".");
}

/**
 * Returns null on anything that does not decrypt cleanly — wrong key, a
 * truncated row, or a tampered one (GCM's tag check catches the last).
 *
 * Null rather than a throw because every caller's honest response is the same:
 * treat the workspace as not connected and ask it to reconnect. A rotated key
 * should degrade to "connect Google Business Profile again", not a 500 on the
 * Integrations page.
 */
export function decryptSecret(payload: string): string | null {
  try {
    const [iv, data, tag] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
    if (!iv || !data || !tag) return null;
    const decipher = crypto.createDecipheriv(ALGO, key(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Store one provider's secret blob for a workspace, replacing any previous one.
 *
 * THROWS when the write does not land, and that is the whole point.
 *
 * supabase-js does not throw on a failed statement — it resolves with an
 * `error` field — so the original `await ...upsert(...)` discarded every
 * failure. The one that mattered: this table's migration had never been
 * applied to the live database, so PostgREST answered 404 and the OAuth
 * callback carried on as though the refresh token were safely stored. The
 * connection reported success, nothing was saved, and every later call said
 * "not connected" — pointing the user back at a Connect button they had
 * already pressed. Hours of debugging for an error the database had returned
 * immediately, in plain words, and we threw away.
 */
export async function saveCredential(
  workspaceId: string,
  provider: string,
  value: unknown,
): Promise<void> {
  const db = createAdminClient();
  const { error } = await db.from("workspace_provider_credentials").upsert(
    {
      workspace_id: workspaceId,
      provider,
      ciphertext: encryptSecret(JSON.stringify(value)),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,provider" },
  );
  if (error) {
    // Carries the database's own words: "Could not find the table" is an
    // actionable sentence, and a generic "couldn't save" is not.
    throw new Error(`Could not store ${provider} credentials: ${error.message}`);
  }
}

export async function readCredential<T>(
  workspaceId: string,
  provider: string,
): Promise<T | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("workspace_provider_credentials")
    .select("ciphertext")
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();

  // A read failure answers null like a genuine miss — the caller's response to
  // both is "treat this as not connected" — but it is logged, because the two
  // are the same to the user and very different to whoever is debugging.
  if (error) console.error(`[credentials] read ${provider} failed:`, error.message);

  const ciphertext = (data as { ciphertext?: string } | null)?.ciphertext;
  if (!ciphertext) return null;
  const plain = decryptSecret(ciphertext);
  if (plain === null) return null;
  try {
    return JSON.parse(plain) as T;
  } catch {
    return null;
  }
}

export async function deleteCredential(workspaceId: string, provider: string): Promise<void> {
  const db = createAdminClient();
  const { error } = await db
    .from("workspace_provider_credentials")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("provider", provider);
  // Louder than the read, for the same reason the disconnect button exists at
  // all: telling someone their access was revoked when the row is still there
  // is the one failure here with a privacy cost.
  if (error) {
    throw new Error(`Could not remove ${provider} credentials: ${error.message}`);
  }
}
