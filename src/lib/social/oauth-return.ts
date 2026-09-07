import { NextResponse } from "next/server";

/** Same-origin channel used to hand an OAuth result back to the tab that started it. */
export const INTEGRATION_RETURN_CHANNEL = "automata:integration-return";
export const LEGACY_INTEGRATION_RETURN_CHANNEL = "zidaneai:integration-return";

export interface IntegrationReturnMessage {
  type: "automata:integration-complete" | "zidaneai:integration-complete";
  platform: string;
  connected: boolean;
}

/**
 * The OAuth RETURN LEG, shared by every provider that has one.
 *
 * Lifted out of `api/integrations/callback/route.ts` when Google Business
 * Profile needed its own callback: it is the only integration whose handshake
 * we run ourselves (no Composio toolkit exists), but the user should not be
 * able to tell — same popup close, same tab hand-back, same toast.
 *
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
    type: "automata:integration-complete",
    platform,
    connected,
  }).replace(/</g, "\\u003c");
  const legacyMessage = JSON.stringify({
    type: "zidaneai:integration-complete",
    platform,
    connected,
  }).replace(/</g, "\\u003c");
  const channel = JSON.stringify(INTEGRATION_RETURN_CHANNEL);
  const legacyChannel = JSON.stringify(LEGACY_INTEGRATION_RETURN_CHANNEL);
  const fallback = JSON.stringify(dest.toString()).replace(/</g, "\\u003c");

  return new NextResponse(
    `<!doctype html>
<html><head><meta charset="utf-8"><title>Connection complete</title></head>
<body><p>Connection complete. You can close this tab and return to Automata.</p>
<p><a id="return-link">Return to Automata</a></p>
<script>
(() => {
  const message = ${message};
  const legacyMessage = ${legacyMessage};
  const fallback = ${fallback};
  document.getElementById("return-link")?.setAttribute("href", fallback);
  try {
    const ch = new BroadcastChannel(${channel});
    ch.postMessage(message);
    ch.close();
  } catch (_) {}
  try {
    const legacyCh = new BroadcastChannel(${legacyChannel});
    legacyCh.postMessage(legacyMessage);
    legacyCh.close();
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

/**
 * `popup` is a parameter rather than something read off the request, because
 * the two callbacks carry it differently: Composio's comes back as a query
 * param on our own callback URL, while Google forbids varying the redirect URI
 * at all, so Business Profile smuggles it inside the signed `state`. Sniffing
 * the request would have worked for one of them.
 */
export function completeOAuthReturn(
  dest: URL,
  platform: string,
  connected: boolean,
  popup: boolean,
): NextResponse {
  if (popup) return popupComplete(dest, platform, connected);
  dest.searchParams.set(connected ? "connected" : "error", platform);
  return NextResponse.redirect(dest);
}

