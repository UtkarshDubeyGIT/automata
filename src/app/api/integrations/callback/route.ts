import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";
import { socialProvider, normalizeSlug, SLUG_RE } from "@/lib/social/composio";
import { persistIntegration } from "@/lib/social/integrations-store";
import { safeNext } from "@/lib/auth/redirects";
import { completeOAuthReturn } from "@/lib/social/oauth-return";

/**
 * OAuth return leg. Composio redirects here after the user authorizes.
 *
 * Query params are attacker-forgeable (this is a plain GET), so nothing here
 * trusts them for state: the platform slug is validated and used only to know
 * which toolkit to VERIFY — the actual status is read back from Composio for
 * the signed-in user's own entity. A forged "status=success" for a connection
 * that doesn't exist verifies as not-connected and lands on an error toast.
 */
export async function GET(req: NextRequest) {
  const slug = normalizeSlug(req.nextUrl.searchParams.get("platform") ?? "");
  const popup = req.nextUrl.searchParams.get("returnMode") === "popup";
  // Set when the connect was started somewhere other than the Integrations
  // screen — the goal console, mainly. Validated, because it is a redirect.
  const dest = new URL(
    safeNext(req.nextUrl.searchParams.get("return"), "/integrations"),
    env.appUrl,
  );

  if (!SLUG_RE.test(slug) || !socialProvider.live) {
    return NextResponse.redirect(dest);
  }

  const ctx = await resolveRequestContext();
  // Whoever landed here has no identity we can verify against — most likely
  // the session expired during the provider round-trip. There is no entity to
  // read the new connection back from, and guessing one would attribute it to
  // the wrong tenant. Send them to the page; its own status fetch settles it
  // once they are signed in again.
  if (!ctx.entityId) {
    return completeOAuthReturn(dest, slug, false, popup);
  }

  try {
    const connections = await socialProvider.listConnections(ctx.entityId);
    const state = connections.find((c) => c.platform === slug);
    if (state) {
      await persistIntegration(ctx, slug, state.status, state.accountId);
    }
    return completeOAuthReturn(dest, slug, state?.status === "connected", popup);
  } catch {
    // Composio unreachable — let the page's live status fetch settle it.
    return completeOAuthReturn(dest, slug, false, popup);
  }
}
