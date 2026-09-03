import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";
import { socialProvider, normalizeSlug, SLUG_RE } from "@/lib/social/composio";
import { persistIntegration } from "@/lib/social/integrations-store";
import { safeNext } from "@/lib/auth/redirects";
import { INTEGRATION_RETURN_CHANNEL } from "@/lib/social/oauth-return";

/**
 * A connect started from an in-progress workflow opens Composio in another
 * tab so the workflow state stays mounted. Once Composio sends the browser
 * back here, notify that original tab and close this tab instead of rendering
 * a second, empty workflow page in it.
 */
function popupComplete(
  dest: URL,
  platform: string,
  connected: boolean,
): NextResponse {
  const message = JSON.stringify({
    type: "zidaneai:integration-complete",
    platform,
    connected,
  }).replace(/</g, "\\u003c");
  const channel = JSON.stringify(INTEGRATION_RETURN_CHANNEL);
  const fallback = JSON.stringify(dest.toString()).replace(/</g, "\\u003c");

  return new NextResponse(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection complete</title></head>
<body><p>Connection complete. You can close this tab and return to ZidaneAI.</p>
<p><a id="return-link">Return to ZidaneAI</a></p>
<script>
(() => {
  const message = ${message};
  const fallback = ${fallback};
  document.getElementById("return-link")?.setAttribute("href", fallback);
  try {
    const channel = new BroadcastChannel(${channel});
    channel.postMessage(message);
    channel.close();
  } catch (_) {}
  window.close();
})();
</script></body></html>`,
    {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    },
  );
}

function complete(
  req: NextRequest,
  dest: URL,
  platform: string,
  connected: boolean,
): NextResponse {
  if (req.nextUrl.searchParams.get("returnMode") === "popup") {
    return popupComplete(dest, platform, connected);
  }
  dest.searchParams.set(connected ? "connected" : "error", platform);
  return NextResponse.redirect(dest);
}

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
    return complete(req, dest, slug, false);
  }

  try {
    const connections = await socialProvider.listConnections(ctx.entityId);
    const state = connections.find((c) => c.platform === slug);
    if (state) {
      await persistIntegration(ctx, slug, state.status, state.accountId);
    }
    return complete(req, dest, slug, state?.status === "connected");
  } catch {
    // Composio unreachable — let the page's live status fetch settle it.
    return complete(req, dest, slug, false);
  }
}
