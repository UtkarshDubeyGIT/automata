import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";
import { safeNext } from "@/lib/auth/redirects";
import {
  socialProvider,
  normalizeSlug,
  hasOwnOAuthApp,
  PLATFORMS,
  SLUG_RE,
} from "@/lib/social/composio";
import { SIMULATED_APPS } from "@/lib/workflows/registry";
import {
  persistIntegration,
  readCachedIntegrations,
  syncConnections,
} from "@/lib/social/integrations-store";

/**
 * Every handler here is scoped by `ctx.entityId` — the Composio entity, i.e.
 * the workspace. A null entity means the request proved no identity, and
 * there is no safe id to substitute: asking Composio "what is connected for
 * nobody?" used to mean asking it about a shared bucket that every signed-out
 * visitor wrote into. So null answers "nothing" and refuses to write.
 */
const NO_IDENTITY = "Sign in to manage integrations.";

/** Begin OAuth for any toolkit. Returns a hosted connect link to redirect to. */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    platform?: string;
    returnTo?: string;
    /** Return the result to the existing tab that owns an in-progress flow. */
    returnMode?: string;
    /** "key" = the user pressed a button that said they'd paste their own key. */
    mode?: string;
  };
  const slug = body.platform ? normalizeSlug(body.platform) : "";
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const ctx = await resolveRequestContext();
  if (!ctx.entityId) {
    return NextResponse.json({ error: NO_IDENTITY }, { status: 401 });
  }

  // Where to land after the provider round-trip. Connecting a channel from the
  // goal console has to come back to the goal console — bouncing the user to
  // Integrations loses the operation they were in the middle of. Same-origin
  // only: this ends up as a redirect target.
  const returnTo = safeNext(body.returnTo, "/integrations");

  // Apps with no Composio toolkit connect instantly and run simulated.
  if (SIMULATED_APPS.has(slug)) {
    await persistIntegration(ctx, slug, "connected", null);
    return NextResponse.json({ connected: true, simulated: true, needsCredentials: false });
  }

  const callbackUrl = `${env.appUrl}/api/integrations/callback?platform=${slug}&return=${encodeURIComponent(returnTo)}${body.returnMode === "popup" ? "&returnMode=popup" : ""}`;
  // Only ever true because the user pressed "Add key" rather than "Connect".
  // The server still prefers OAuth wherever it can reach it — this is consent
  // to a key when there is no other way in, not an instruction to use one.
  const allowKey = body.mode === "key";
  const result = await socialProvider.connect(ctx.entityId, slug, callbackUrl, { allowKey });

  if (result.needsCredentials) {
    // Nothing was initiated — don't cache a phantom "pending" row.
    return NextResponse.json({
      connected: false,
      simulated: false,
      needsCredentials: true,
      keyFallback: result.keyFallback ?? false,
      error: result.error,
    });
  }
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }

  await persistIntegration(
    ctx,
    slug,
    result.connected ? "connected" : "pending",
    result.accountId,
  );

  return NextResponse.json({
    redirectUrl: result.redirectUrl,
    connected: result.connected,
    simulated: result.simulated ?? false,
    needsCredentials: false,
  });
}

/**
 * Curated channels whose consent screen runs on OUR developer app.
 *
 * The channel cards are static client data, so they cannot tell that
 * `COMPOSIO_OAUTH_TWITTER_CLIENT_ID` has since been filled in — the button
 * would go on reading "Set up" forever. Seven env lookups, no network.
 */
function ownAppChannels(): string[] {
  return PLATFORMS.filter((p) => hasOwnOAuthApp(p.id)).map((p) => p.id);
}

/**
 * Connection state: live from Composio when reachable (reconciling the cache
 * along the way), otherwise served from the cache so an outage or preview
 * mode doesn't blank out every "Connected" badge.
 */
export async function GET() {
  const ctx = await resolveRequestContext();

  // No identity → no connections. This is the answer the onboarding wizard
  // gets before a session exists, and "nothing is connected yet" is the only
  // truthful one: the alternative was reporting a shared entity's tools as
  // this brand-new account's.
  if (!ctx.entityId) {
    return NextResponse.json({
      integrations: [],
      live: socialProvider.live,
      ownApps: ownAppChannels(),
    });
  }

  if (!socialProvider.live) {
    const cached = await readCachedIntegrations(ctx);
    return NextResponse.json({ integrations: cached, live: false, ownApps: ownAppChannels() });
  }

  try {
    const connections = await socialProvider.listConnections(ctx.entityId);
    await syncConnections(ctx, connections);
    // Simulated apps live only in the cache — merge them into the live view.
    const cached = await readCachedIntegrations(ctx);
    const simulated = cached.filter((c) => SIMULATED_APPS.has(c.platform));
    return NextResponse.json({
      integrations: [
        ...connections.map((c) => ({
          platform: c.platform,
          status: c.status,
          connected_account_id: c.accountId,
        })),
        ...simulated,
      ],
      live: true,
      ownApps: ownAppChannels(),
    });
  } catch {
    const cached = await readCachedIntegrations(ctx);
    return NextResponse.json({ integrations: cached, live: true, ownApps: ownAppChannels() });
  }
}

/** Disconnect a toolkit (deletes all of its Composio connected accounts). */
export async function DELETE(req: Request) {
  const body = (await req.json()) as { platform?: string };
  const slug = body.platform ? normalizeSlug(body.platform) : "";
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "Unknown platform" }, { status: 400 });
  }

  const ctx = await resolveRequestContext();
  if (!ctx.entityId) {
    return NextResponse.json({ error: NO_IDENTITY }, { status: 401 });
  }

  try {
    await socialProvider.disconnectPlatform(ctx.entityId, slug);
    await persistIntegration(ctx, slug, "disconnected", null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
