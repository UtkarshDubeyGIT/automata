import { NextResponse, type NextRequest } from "next/server";
import { env, shopifyConfigured } from "@/lib/env";
import { authorizeUrl, normalizeShop, verifyQueryHmac } from "@/lib/shopify/oauth";

/**
 * The App URL — Shopify's entry point, and the route Shopify's automated
 * review check "Immediately authenticates after install" tests.
 *
 * Shopify opens this with a signed `?shop=&hmac=&timestamp=` query when a
 * merchant installs from the App Store or opens the app from their admin. The
 * only correct answer is an immediate redirect to that store's own permission
 * screen: rendering anything first — a landing page, a sign-in, a spinner —
 * fails the check and, before this route existed, is exactly what happened.
 *
 * Nothing here needs a ZidaneAI session, and it must not want one. The whole
 * point of this door is a merchant who has never heard of us until thirty
 * seconds ago; the account gets attached afterwards, in `claim`.
 */
export async function GET(req: NextRequest) {
  if (!shopifyConfigured) {
    // No client secret means no way to tell Shopify from a prober, and this
    // route's output is a redirect built from attacker-supplied input.
    return NextResponse.json({ error: "Shopify is not configured." }, { status: 503 });
  }

  const params = req.nextUrl.searchParams;
  const raw = params.get("shop");

  // Someone reached the URL directly with nothing to act on — a bookmark, a
  // crawler, a person pasting it. Send them to the app rather than an error.
  if (!raw) return NextResponse.redirect(new URL("/integrations", env.appUrl));

  const shop = normalizeShop(raw);
  if (!shop) {
    return NextResponse.json({ error: "Not a valid Shopify store." }, { status: 400 });
  }

  // The signature is what makes the redirect safe to build. Without it anyone
  // could hand us a `shop` of their choosing and we would send the merchant —
  // and our client_id — to a host we never verified.
  if (!verifyQueryHmac(params)) {
    return NextResponse.json({ error: "Unverified Shopify request." }, { status: 401 });
  }

  // `workspaceId: null` — an install that starts here belongs to nobody yet,
  // and inventing an owner is the cross-tenant bug this codebase already has a
  // post-mortem for in `workspace.ts`.
  return NextResponse.redirect(
    authorizeUrl({ shop, workspaceId: null, returnTo: "/integrations" }),
  );
}
