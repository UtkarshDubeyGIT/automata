import { createAdminClient } from "@/lib/supabase/server";
import { encryptSecret, decryptSecret } from "@/lib/credentials";
import type { ShopifyToken } from "@/lib/shopify/oauth";

/**
 * Where a Shopify access token lives between the install and the account.
 *
 * An App Store install hands us a working token before the merchant has a
 * ZidaneAI account, so there is no workspace to file it under. `shopify_installs`
 * (migration 20260905130000) is keyed by shop domain with a NULLABLE
 * workspace_id, and `claimInstall` fills that in once somebody signs in.
 *
 * The token is encrypted with the same AES-256-GCM helper as Google Business
 * Profile's refresh token, for the same reason: it is a long-lived credential
 * granting ongoing read access to a real business's orders and customers.
 * Table-level RLS is on with no policy, so only the service-role client here
 * can reach the ciphertext at all.
 *
 * EVERY WRITE IS CHECKED. A store that reports "connected" while the row never
 * landed sends the merchant back to a button they already pressed, with the
 * real cause — usually an unapplied migration — sitting unread in a discarded
 * PostgREST error. That exact failure is written up in `credentials.ts`; these
 * functions throw with the database's own words rather than repeat it.
 */

export interface StoredInstall extends ShopifyToken {
  shop: string;
  /** Null until a signed-in user claims the store. */
  workspaceId: string | null;
}

/** Upsert the token for a shop, preserving any workspace already attached. */
export async function saveInstall(
  shop: string,
  token: ShopifyToken,
  workspaceId: string | null,
): Promise<void> {
  const db = createAdminClient();

  // A reinstall must not orphan a store that a workspace already owns:
  // Shopify sends the whole flow again on reinstall, and the merchant would
  // otherwise have to re-claim a store that never left their account.
  const existing = workspaceId ? null : await readInstall(shop);

  const { error } = await db.from("shopify_installs").upsert(
    {
      shop,
      ciphertext: encryptSecret(JSON.stringify({ accessToken: token.accessToken })),
      scope: token.scope,
      workspace_id: workspaceId ?? existing?.workspaceId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "shop" },
  );

  if (error) throw new Error(`Could not store the Shopify install: ${error.message}`);
}

/**
 * Null on a genuine miss AND on a read failure — both mean "treat this store
 * as not installed" to the caller — but a failure is logged, because the two
 * look identical to a merchant and nothing alike to whoever is debugging.
 */
export async function readInstall(shop: string): Promise<StoredInstall | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("shopify_installs")
    .select("shop, ciphertext, scope, workspace_id")
    .eq("shop", shop)
    .maybeSingle();

  if (error) {
    console.error("[shopify/installs] read failed:", error.message);
    return null;
  }
  const row = data as {
    shop: string;
    ciphertext: string;
    scope: string;
    workspace_id: string | null;
  } | null;
  if (!row) return null;

  // Decrypt failure is a rotated or wrong key. Null degrades to "reconnect
  // Shopify", which is recoverable; a throw here would 500 the whole page.
  const plain = decryptSecret(row.ciphertext);
  if (plain === null) return null;
  try {
    const { accessToken } = JSON.parse(plain) as { accessToken?: string };
    if (!accessToken) return null;
    return { shop: row.shop, accessToken, scope: row.scope, workspaceId: row.workspace_id };
  } catch {
    return null;
  }
}

/**
 * Attach an unclaimed store to a workspace.
 *
 * Returns false when the row is already owned by a DIFFERENT workspace. That
 * is not an error to shout about — it is one merchant's store being opened by
 * another person's account, and the honest answer is "this store is already
 * connected elsewhere" rather than silently moving it.
 */
export async function claimInstall(shop: string, workspaceId: string): Promise<boolean> {
  const existing = await readInstall(shop);
  if (!existing) return false;
  if (existing.workspaceId && existing.workspaceId !== workspaceId) return false;
  if (existing.workspaceId === workspaceId) return true;

  const db = createAdminClient();
  const { error } = await db
    .from("shopify_installs")
    .update({ workspace_id: workspaceId, updated_at: new Date().toISOString() })
    .eq("shop", shop)
    // Only claim a row that is still unowned. Without this the check above is
    // a read-then-write race: two tabs finishing the same install would each
    // pass the read and the later write would win silently.
    .is("workspace_id", null);

  if (error) throw new Error(`Could not attach ${shop}: ${error.message}`);
  return true;
}

/**
 * Forget a store entirely — used by `shop/redact` (Shopify's mandatory
 * erasure webhook) and by uninstall.
 *
 * Louder than a read failure, and for the same reason `deleteCredential` is:
 * reporting an erasure that did not happen is the one failure here with a
 * legal cost attached.
 */
export async function deleteInstall(shop: string): Promise<void> {
  const db = createAdminClient();
  const { error } = await db.from("shopify_installs").delete().eq("shop", shop);
  if (error) throw new Error(`Could not remove the Shopify install for ${shop}: ${error.message}`);
}
