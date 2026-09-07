import { NextResponse, type NextRequest } from "next/server";
import { env, shopifyConfigured } from "@/lib/env";
import {
  exchangeToken,
  normalizeShop,
  signState,
  verifyQueryHmac,
  verifyState,
} from "@/lib/shopify/oauth";
import { saveInstall } from "@/lib/shopify/installs";

/**
 * Shopify's return leg, and the route the "Immediately redirects to app UI
 * after authentication" check watches.
 *
 * Three things are verified before the code is spent, and each one is a real
 * attack rather than defensive habit:
 *
 *  - the query `hmac`, because this is a plain GET anyone can construct;
 *  - our own signed `state`, because that is the only field that survives the
 *    round-trip carrying who started the flow;
 *  - that the `shop` in the query matches the `shop` inside the state, because
 *    a valid state from one store replayed against another would otherwise
 *    file that store's token under the first one's flow.
 *
 * The redirect at the end goes to `claim`, not to the dashboard. Attaching the
 * store needs a signed-in user and there may not be one yet.
 */
export async function GET(req: NextRequest) {
  if (!shopifyConfigured) {
    return NextResponse.json({ error: "Shopify is not configured." }, { status: 503 });
  }

  const params = req.nextUrl.searchParams;
  const failed = new URL("/integrations?shopify=failed", env.appUrl);

  const code = params.get("code");
  const shop = normalizeShop(params.get("shop"));
  const state = verifyState(params.get("state"));

  // No code is the ordinary outcome of pressing Cancel on Shopify's permission
  // screen, not an error worth a stack trace.
  if (!code || !shop || !state) return NextResponse.redirect(failed);
  if (state.shop !== shop) return NextResponse.redirect(failed);
  if (!verifyQueryHmac(params)) return NextResponse.redirect(failed);

  try {
    const token = await exchangeToken(shop, code);
    // Stored BEFORE the redirect reports anything. `saveInstall` throws on a
    // failed write rather than returning quietly, so a store can never be
    // announced as installed on the strength of a row that never landed.
    await saveInstall(shop, token, state.workspaceId);
  } catch (err) {
    console.error("[shopify/callback] install failed:", err);
    return NextResponse.redirect(failed);
  }

  const claim = signState({ shop, workspaceId: state.workspaceId, returnTo: state.returnTo });
  return NextResponse.redirect(
    new URL(`/api/shopify/claim?state=${encodeURIComponent(claim)}`, env.appUrl),
  );
}
