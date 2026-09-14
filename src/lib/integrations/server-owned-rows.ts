import { firecrawlConfigured, googleBusinessConfigured } from "@/lib/env";
import type { RequestContext } from "@/lib/workspace";
import type { IntegrationRow } from "@/lib/workflows/apps";
import { vikunjaStatus } from "./vikunja-connection";

/**
 * Connection rows for the apps in `SERVER_OWNED_APPS` — the ones Composio can
 * never list because we hold the credentials ourselves.
 *
 * `statusOf` reads a MISSING row for one of these as "none" (or "simulated"),
 * so every caller that folds Composio's listing into `connectionsOf` has to
 * add these rows itself. Three places do: the status endpoint the UI reads,
 * the activation switch, and publish. When only the first one remembered
 * Vikunja, the editor showed it connected while publish answered "Connect
 * Vikunja before publishing" — so the answer is written once here.
 *
 *   firecrawl              on when the server holds a Firecrawl key.
 *   vikunja                on when this workspace stored a verified token.
 *   googlebusinessprofile  from the cache (the OAuth grant names the workspace
 *                          as its account), but only once the deployment has a
 *                          Google client — before that, absence means demo.
 *
 * `cached` is the workspace's `integrations` rows when the caller already has
 * them; otherwise Business Profile is derived from nothing and reads "none".
 * Never throws: a credential store that can't be read must not turn a valid
 * draft into a refusal, so Vikunja falls back to "none" and the run itself
 * re-checks the connection.
 */
export async function serverOwnedRows(
  ctx: Pick<RequestContext, "workspaceId">,
  cached: IntegrationRow[] = [],
): Promise<IntegrationRow[]> {
  return [
    { platform: "firecrawl", status: firecrawlConfigured ? "connected" : "none" },
    await vikunjaRow(ctx.workspaceId),
    ...businessProfileRow(cached),
  ];
}

export async function vikunjaRow(
  workspaceId: string | null,
): Promise<IntegrationRow & { instanceUrl: string }> {
  if (!workspaceId) return { platform: "vikunja", status: "none", instanceUrl: "" };
  try {
    const status = await vikunjaStatus(workspaceId);
    return {
      platform: "vikunja",
      status: status.connected ? "connected" : "none",
      instanceUrl: status.instanceUrl,
    };
  } catch {
    return { platform: "vikunja", status: "none", instanceUrl: "" };
  }
}

/**
 * Google Business Profile's row, which Composio can never supply.
 *
 * It is stated EXPLICITLY rather than left absent, because absence already
 * means something: `statusOf` reads a missing row for this app as demo mode.
 * That is right when the deployment has no Google client, and wrong the moment
 * it does — a configured-but-unconnected workspace would be shown "Demo" and
 * never offered the Connect button that would fix it.
 */
export function businessProfileRow(cached: IntegrationRow[]): IntegrationRow[] {
  if (!googleBusinessConfigured) return [];
  const connected = cached.some(
    (row) => row.platform === "googlebusinessprofile" && row.status === "connected",
  );
  return [{ platform: "googlebusinessprofile", status: connected ? "connected" : "none" }];
}
