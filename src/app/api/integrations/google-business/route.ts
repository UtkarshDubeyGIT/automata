import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { safeNext } from "@/lib/auth/redirects";
import {
  authorizeUrl,
  businessProfileConfigured,
  disconnect,
  resolveState,
  stateMessage,
} from "@/lib/google/business-profile";
import { persistIntegration } from "@/lib/social/integrations-store";
import { setupNotice } from "@/lib/setup-notice";

/**
 * Google Business Profile's own status and disconnect endpoint.
 *
 * STARTING the flow lives on `/api/integrations/connect` with every other
 * integration — the Integrations screen posts one slug to one endpoint, and
 * which provider Composio happens to cover is not its business. What cannot
 * live there is the rest: Composio has no toolkit here, so there is no
 * connection for `listConnections` to report and no account for
 * `disconnectPlatform` to delete. Those two answers come from here instead.
 *
 * POST is kept as the direct entry point for callers that already know they
 * want this provider (the reviews surface, tests), and returns the same shape.
 */

/**
 * Failures that happen AFTER a completed handshake.
 *
 * The distinction matters because the remedies are opposites: "reconnect" is
 * useless advice for someone whose token is fine and whose Google account
 * simply owns no shop, and offering them a Connect button they have already
 * pressed is how an integration feels broken when it is merely unfinished.
 */
const AUTHORIZED_BUT_UNUSABLE = new Set(["no_location", "unavailable"]);

export async function POST(req: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to manage integrations." }, { status: 401 });
  }
  if (!businessProfileConfigured) {
    return NextResponse.json(
      {
        error: setupNotice(
          "Google Business Profile isn't available on this workspace yet.",
          "Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, with the business.manage scope on the consent screen.",
        ),
      },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    returnTo?: string;
    returnMode?: string;
  };
  // Validated here rather than on the way back: `safeNext` keeps it
  // same-origin, and once inside the signed state it cannot be edited at all.
  // Google forbids varying the redirect_uri, so this is the only way home.
  const returnTo = safeNext(body.returnTo, "/integrations");

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

/** Current state, in the vocabulary the Integrations screen already speaks. */
export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.workspaceId) {
    return NextResponse.json({ status: "none", configured: businessProfileConfigured });
  }
  const state = await resolveState(ctx.workspaceId);
  /*
   * "Authorized but not usable" is its own state, and flattening it to "none"
   * is what made this integration so hard to debug: a workspace that had
   * genuinely completed the Google handshake looked identical to one that had
   * never pressed Connect.
   *
   * `usable` is what the workflow engine cares about; `status` stays in the
   * Integrations screen's existing vocabulary; `message` is the sentence to
   * put in front of the user, which for a Google refusal is Google's own.
   */
  const authorized = state.ok || AUTHORIZED_BUT_UNUSABLE.has(state.reason);
  return NextResponse.json({
    configured: businessProfileConfigured,
    status: authorized ? "connected" : "none",
    usable: state.ok,
    reason: state.ok ? null : state.reason,
    message: state.ok ? null : stateMessage(state.reason, state.detail),
  });
}

export async function DELETE() {
  const ctx = await resolveRequestContext();
  if (!ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to manage integrations." }, { status: 401 });
  }
  await disconnect(ctx.workspaceId);
  await persistIntegration(ctx, "googlebusinessprofile", "disconnected", null);
  return NextResponse.json({ ok: true });
}
