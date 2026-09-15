import type { RequestContext } from "@/lib/workspace";
import { createAdminClient } from "@/lib/supabase/server";
import { SERVER_OWNED_APPS } from "@/lib/workflows/apps";
import type { ConnectionState } from "./composio";

/**
 * The `integrations` table is a workspace-scoped CACHE of Composio connection
 * state — Composio is the source of truth whenever it's reachable. This module
 * is the only writer, so the status vocabulary lives in one place:
 *   connected | pending | disconnected
 * All writes are best-effort: a cache miss must never fail a request.
 */

export interface CachedIntegration {
  platform: string;
  status: "connected" | "pending" | "disconnected";
  connected_account_id: string | null;
}

/** Only a server-verified workspace may update provider connection facts. */
function cacheWriter(ctx: RequestContext) {
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId || ctx.entityId !== ctx.workspaceId) return null;
  // The browser can read its workspace cache, but cannot manufacture an
  // authorized connection by inserting a row directly into the Data API.
  return createAdminClient();
}

/** Record one platform's state (connect initiated, OAuth completed, disconnect). */
export async function persistIntegration(
  ctx: RequestContext,
  platform: string,
  status: "connected" | "pending" | "disconnected",
  accountId?: string | null,
): Promise<void> {
  try {
    const db = cacheWriter(ctx);
    if (!db) return;
    await db.from("integrations").upsert(
      {
        workspace_id: ctx.workspaceId,
        platform,
        status,
        connected_account_id: accountId ?? null,
      },
      { onConflict: "workspace_id,platform" },
    );
  } catch {
    // Cache only.
  }
}

/**
 * Serve connection state from the cache — used when Composio is unreachable
 * or unconfigured.
 *
 * A cached row may only claim `connected` if it can name the Composio account
 * behind it. Composio is the source of truth for "is this authorized"; a row
 * with no `connected_account_id` is a claim nothing can honour — the first
 * publish through it fails, because there is no account to publish with.
 *
 * Rows like that are real and predate this check: an early onboarding step
 * seeded whatever the user ticked as `connected`, so workspaces reported
 * integrations that had never seen an OAuth handshake. Onboarding stopped
 * writing them, but the rows outlived the bug, and every path that falls back
 * to the cache — Composio down, Composio unconfigured — served them straight
 * back as "Connected".
 *
 * There is no longer an exception for simulated apps. There used to be: an app
 * with no Composio toolkit was "connected by definition", so its id-less row
 * was let through. That exemption is what kept the phantom rows alive, and it
 * became actively dangerous once Google Business Profile gained a real
 * integration — an old fabricated row would have been indistinguishable from a
 * genuine OAuth grant. `POST /api/integrations/connect` no longer writes one,
 * and a real Business Profile connection names its workspace as the account,
 * so it passes this rule like everything else.
 */
export async function readCachedIntegrations(
  ctx: RequestContext,
): Promise<CachedIntegration[]> {
  if (!ctx.supabase || !ctx.workspaceId) return [];
  try {
    // "disconnected" is included so a broken toolkit reads back as broken,
    // not as absent — the page has to tell those two apart (see
    // integrations-page.tsx's CardActions). It never carries a
    // connected_account_id, so the phantom-row filter below can't be fooled
    // by it.
    const { data } = await ctx.supabase
      .from("integrations")
      .select("platform, status, connected_account_id")
      .eq("workspace_id", ctx.workspaceId)
      .in("status", ["connected", "pending", "disconnected"]);
    return ((data as CachedIntegration[]) ?? []).filter(
      (row) => row.status !== "connected" || !!row.connected_account_id,
    );
  } catch {
    return [];
  }
}

/**
 * Reconcile the cache against a successful live listing: one batched upsert
 * for everything Composio reports, then downgrade rows for platforms it no
 * longer returns (revoked, expired, deleted) so the cache can't ratchet
 * toward "connected" forever.
 */
export async function syncConnections(
  ctx: RequestContext,
  connections: ConnectionState[],
): Promise<void> {
  try {
    const db = cacheWriter(ctx);
    if (!db) return;
    if (connections.length > 0) {
      await db.from("integrations").upsert(
        connections.map((c) => ({
          workspace_id: ctx.workspaceId,
          platform: c.platform,
          status: c.status,
          connected_account_id: c.accountId,
        })),
        { onConflict: "workspace_id,platform" },
      );
    }

    // Composio cannot report what it does not host. Google Business Profile is
    // connected through our own OAuth client, so it is absent from every live
    // listing by definition — without this it would be downgraded to
    // "disconnected" on the very next status read, seconds after the user
    // finished authorizing.
    const keep = [
      ...connections.map((c) => c.platform),
      ...SERVER_OWNED_APPS,
    ];
    await db
      .from("integrations")
      .update({ status: "disconnected", connected_account_id: null })
      .eq("workspace_id", ctx.workspaceId)
      .in("status", ["connected", "pending"])
      .not("platform", "in", `(${keep.map((p) => `"${p}"`).join(",")})`);
  } catch {
    // Cache only.
  }
}

/**
 * Mark one workspace's cached connection to a toolkit as broken.
 *
 * Called from the inbound webhook route on `composio.connected_account.expired`
 * — an admin client is passed in rather than resolved here, because that route
 * has no signed-in session to build a `RequestContext` from (Composio calls it
 * server-to-server). Same downgrade `syncConnections` makes on its next live
 * read; this just makes the Integrations page reflect it immediately, instead
 * of after the workspace's next successful poll — which may be a long time
 * away for a workflow that was running on push precisely because it never
 * polled.
 */
export async function markIntegrationExpired(
  admin: ReturnType<typeof createAdminClient>,
  workspaceId: string,
  platform: string,
): Promise<void> {
  try {
    await admin
      .from("integrations")
      .update({ status: "disconnected", connected_account_id: null })
      .eq("workspace_id", workspaceId)
      .eq("platform", platform);
  } catch {
    // Cache only — the next live sync corrects this regardless.
  }
}
