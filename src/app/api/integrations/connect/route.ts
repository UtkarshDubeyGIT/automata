import { NextResponse } from "next/server";
import { env, googleBusinessConfigured as businessProfileConfigured } from "@/lib/env";
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
import { SERVER_OWNED_APPS } from "@/lib/workflows/apps";
import {
  authorizeUrl,
  disconnect as disconnectBusinessProfile,
} from "@/lib/google/business-profile";
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
  const returnTo = safeNext(body.returnTo, "/app/integrations");

  // Google Business Profile has no Composio toolkit, so its handshake is ours.
  // It still answers HERE, in the same shape, because the Integrations screen
  // posts one slug to one endpoint and should not have to know which of our
  // integrations Composio happens to cover.
  if (slug === "googlebusinessprofile" && businessProfileConfigured && ctx.workspaceId) {
    return NextResponse.json({
      redirectUrl: authorizeUrl({
        workspaceId: ctx.workspaceId,
        returnTo,
        popup: body.returnMode === "popup",
      }),
      connected: false,
      simulated: false,
      needsCredentials: false,
    });
  }

  /*
   * Apps with no toolkit AND no native integration run simulated.
   *
   * This used to write a cached `connected` row, and that row was a lie with
   * consequences: `readCachedIntegrations` exempted simulated apps from the
   * "must name a Composio account" rule, so it survived every reconciliation
   * and every status read. Nothing is written now — `statusOf` reports demo
   * mode from the app itself, which cannot drift, and an install that later
   * gains real credentials is not left with phantom rows claiming a
   * connection that never happened.
   */
  if (SIMULATED_APPS.has(slug)) {
    return NextResponse.json({ connected: false, simulated: true, needsCredentials: false });
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
 * Google Business Profile's row, which Composio can never supply.
 *
 * It is stated EXPLICITLY rather than left absent, because absence already
 * means something: `statusOf` reads a missing row for this app as demo mode.
 * That is right when the deployment has no Google client, and wrong the moment
 * it does — a configured-but-unconnected workspace would be shown "Demo" and
 * never offered the Connect button that would fix it.
 */
function businessProfileRow(
  cached: { platform: string; status: string }[],
): { platform: string; status: string }[] {
  if (!businessProfileConfigured) return [];
  const connected = cached.some(
    (row) => row.platform === "googlebusinessprofile" && row.status === "connected",
  );
  return [{ platform: "googlebusinessprofile", status: connected ? "connected" : "none" }];
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
    return NextResponse.json({
      integrations: [...cached, ...businessProfileRow(cached)],
      live: false,
      ownApps: ownAppChannels(),
    });
  }

  try {
    const connections = await socialProvider.listConnections(ctx.entityId);
    await syncConnections(ctx, connections);
    // Apps we host ourselves are absent from every Composio listing, so their
    // rows come from the cache and are merged into the live view.
    const cached = await readCachedIntegrations(ctx);
    // Business Profile is excluded here and stated once below instead — two
    // rows for one app would leave `statusOf` reading whichever came first.
    const own = cached.filter(
      (c) => SERVER_OWNED_APPS.has(c.platform) && c.platform !== "googlebusinessprofile",
    );
    return NextResponse.json({
      integrations: [
        ...connections.map((c) => ({
          platform: c.platform,
          status: c.status,
          connected_account_id: c.accountId,
        })),
        ...own,
        ...businessProfileRow(cached),
      ],
      live: true,
      ownApps: ownAppChannels(),
    });
  } catch {
    const cached = await readCachedIntegrations(ctx);
    return NextResponse.json({
      integrations: [...cached, ...businessProfileRow(cached)],
      live: true,
      ownApps: ownAppChannels(),
    });
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
    // Composio has no connected account to delete for an app it does not host,
    // so asking it to would 404 and leave our own stored refresh token in
    // place — a "disconnect" that revokes nothing is worse than no button.
    if (slug === "googlebusinessprofile") {
      await disconnectBusinessProfile(ctx.workspaceId ?? "");
    } else {
      await socialProvider.disconnectPlatform(ctx.entityId, slug);
    }
    await persistIntegration(ctx, slug, "disconnected", null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
