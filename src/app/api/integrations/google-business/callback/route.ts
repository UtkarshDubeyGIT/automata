import type { NextRequest } from "next/server";
import { env } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";
import { safeNext } from "@/lib/auth/redirects";
import { completeOAuthReturn } from "@/lib/social/oauth-return";
import { completeConnect, stateMessage, verifyState } from "@/lib/google/business-profile";
import { persistIntegration } from "@/lib/social/integrations-store";

const PLATFORM = "googlebusinessprofile";

/**
 * Google's return leg for Business Profile.
 *
 * The workspace is taken from the SIGNED `state`, never from the session and
 * never from a query parameter. Two reasons, and both are real:
 *
 *  - a query parameter here is attacker-controlled, so an unsigned workspace
 *    id would let anyone attach their own Google business to someone else's
 *    workspace by editing the URL;
 *  - the session is the wrong source even when it exists. The user may have
 *    signed into a different Google account in this browser during the
 *    round-trip, and the tokens belong to whoever STARTED the flow.
 *
 * The signature is then cross-checked against the live session below, so a
 * replayed state from another tenant still cannot land tokens anywhere.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const raw = req.nextUrl.searchParams.get("state");
  const state = raw ? verifyState(raw) : null;

  // Where to land. A forged or expired state has no trustworthy return path,
  // so it falls back to the Integrations page rather than anywhere it named.
  const dest = new URL(safeNext(state?.returnTo, "/app/integrations"), env.appUrl);
  const popup = !!state?.popup;

  // No code means the user pressed Cancel on Google's consent screen — an
  // ordinary outcome, not an error worth a stack trace.
  if (!code || !state) return completeOAuthReturn(dest, PLATFORM, false, popup);

  const ctx = await resolveRequestContext();
  // A valid signature proves the flow started here; matching it to the session
  // proves it started as THIS user. Without the second check a stolen state
  // string could be replayed by anyone who obtained it.
  if (!ctx.workspaceId || ctx.workspaceId !== state.workspaceId) {
    return completeOAuthReturn(dest, PLATFORM, false, popup);
  }

  let outcome;
  try {
    outcome = await completeConnect(state.workspaceId, code);
  } catch (err) {
    console.error("[google-business/callback] connect failed:", err);
    return completeOAuthReturn(dest, PLATFORM, false, popup);
  }

  // Mirror the row every other integration writes, so the Integrations screen,
  // the workflow connection pre-check and `requiredAppsOf` all see it without
  // learning that this one is special.
  await persistIntegration(ctx, PLATFORM, "connected", state.workspaceId);

  /*
   * Connected, and useless — say so NOW.
   *
   * Signing in with a personal Google account is an easy mistake to make and
   * an invisible one to have made: the consent screen looks identical, the
   * grant is real, and the row goes green. The first sign anything was wrong
   * used to be a failed run — and for a review workflow that means AFTER a
   * person had read and approved a drafted reply, which is the most expensive
   * possible moment to learn the account was never going to work.
   *
   * Only when Google actually ANSWERED the lookup. A failed lookup is a
   * different problem (project setup, a blip) and `resolveState` retries it on
   * every later call, so guessing here would cry wolf at a connection that is
   * about to start working on its own.
   */
  const warning =
    outcome.checked && !outcome.listing
      ? stateMessage("no_location")
      : undefined;
  return completeOAuthReturn(dest, PLATFORM, true, popup, warning);
}

