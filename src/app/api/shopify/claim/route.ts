import { NextResponse, type NextRequest } from "next/server";
import { env, shopifyConfigured } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";
import { safeNext } from "@/lib/auth/redirects";
import { verifyClaim } from "@/lib/shopify/oauth";
import { attachStore } from "@/lib/shopify/connect";
import { persistIntegration } from "@/lib/social/integrations-store";

const PLATFORM = "shopify";

/**
 * Attach an installed store to whoever is signed in.
 *
 * This step exists because the two ways into Shopify arrive with different
 * amounts of identity. A merchant who pressed Connect inside ZidaneAI already
 * has a workspace; a merchant who installed from the App Store has a working
 * token and no account at all. Rather than branch the OAuth on that, the
 * callback always lands here and this route resolves ownership once.
 *
 * The shop name comes from the SIGNED claim token, never a query parameter —
 * an unsigned shop here would let anyone type another merchant's store domain
 * and attach that store, and its orders, to their own workspace.
 *
 * Being signed out is expected, not an error: send them to sign in and come
 * straight back. The claim token is good for seven days precisely so that
 * round-trip can include an emailed signup confirmation.
 */
export async function GET(req: NextRequest) {
  if (!shopifyConfigured) {
    return NextResponse.json({ error: "Shopify is not configured." }, { status: 503 });
  }

  const claim = verifyClaim(req.nextUrl.searchParams.get("state"));
  if (!claim) {
    return NextResponse.redirect(new URL("/integrations?shopify=expired", env.appUrl));
  }

  const dest = new URL(safeNext(claim.returnTo, "/integrations"), env.appUrl);
  const ctx = await resolveRequestContext();

  if (!ctx.workspaceId || !ctx.entityId) {
    // Round-trip through sign-in and return to this exact URL. `next` is
    // path-only because `safeNext` on the other side rejects anything else —
    // which is what stops this from becoming an open redirect.
    const login = new URL("/login", env.appUrl);
    login.searchParams.set("next", `${req.nextUrl.pathname}${req.nextUrl.search}`);
    return NextResponse.redirect(login);
  }

  try {
    const { accountId } = await attachStore(ctx.entityId, ctx.workspaceId, claim.shop);
    // The same row every other integration writes, so the Integrations screen
    // and the workflow connection pre-check see this store without learning
    // that its install took a different road.
    await persistIntegration(ctx, PLATFORM, "connected", accountId);
  } catch (err) {
    console.error("[shopify/claim] attach failed:", err);
    dest.searchParams.set("shopify", "failed");
    return NextResponse.redirect(dest);
  }

  dest.searchParams.set("connected", PLATFORM);
  return NextResponse.redirect(dest);
}
