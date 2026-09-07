import crypto from "node:crypto";
import { env, googleBusinessConfigured } from "@/lib/env";
import { readCredential, saveCredential, deleteCredential } from "@/lib/credentials";

/**
 * Google Business Profile — the one Google integration that is our own code.
 *
 * WHY IT IS NOT COMPOSIO. There is no toolkit. Checked against the live v3
 * catalog: `googlebusinessprofile`, `google_business_profile`,
 * `googlemybusiness`, `google_my_business`, `gmb` and `google_business` all
 * return 404. Composio's search surfaces only third-party scrapers (OneUp,
 * DataForSEO) which read a public listing and cannot post an owner reply. So
 * this module performs the OAuth handshake, holds the refresh token (encrypted
 * — see `credentials.ts`) and calls Google directly.
 *
 * WHY IT IS FOUR APIS. "Business Profile" is not one service:
 *   Account Management     — which business accounts this login owns.
 *   Business Information   — the locations under an account.
 *   My Business v4 (legacy)— reviews and replies. Google never migrated these
 *                            to a v1 surface; v4 is not a fallback, it is the
 *                            only place a review reply exists.
 *
 * ACCESS IS GRANTED PER CLOUD PROJECT. Enabling the APIs is not enough: the
 * Business Profile API access request must be approved for the same project
 * that issued GOOGLE_CLIENT_ID, or every call returns 403 with a quota of
 * zero. A client from a different project does not inherit the approval.
 */

const OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN = "https://oauth2.googleapis.com/token";
const ACCOUNTS = "https://mybusinessaccountmanagement.googleapis.com/v1";
const INFORMATION = "https://mybusinessbusinessinformation.googleapis.com/v1";
/** Reviews live only on the legacy surface. Not a fallback — the only route. */
const REVIEWS = "https://mybusiness.googleapis.com/v4";

/** The single scope that covers reading and replying. */
const SCOPE = "https://www.googleapis.com/auth/business.manage";

/** Provider key in `workspace_provider_credentials`. */
export const PROVIDER = "googlebusinessprofile";

export const businessProfileConfigured = googleBusinessConfigured;

export function callbackUrl(): string {
  return `${env.appUrl}/api/integrations/google-business/callback`;
}

interface StoredTokens {
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. */
  expiresAt?: number;
  /** Chosen once at connect time so every later call skips two lookups. */
  accountName?: string;
  locationName?: string;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

/**
 * Signed `state` — the callback's ONLY input it is allowed to trust.
 *
 * Google echoes `state` back and nothing else of ours: the `redirect_uri` must
 * match the one registered in the Cloud console byte for byte, so unlike the
 * Composio callback we cannot hang `?return=` or `?returnMode=` off it. Both
 * therefore travel inside the signed payload.
 *
 * Signing is not optional for any of the three. An unsigned workspace id lets
 * anyone attach THEIR Google business to SOMEONE ELSE's workspace by editing
 * the URL; an unsigned return path is an open redirect. The HMAC uses a key
 * the browser never sees, and the timestamp bounds replay.
 */
export interface OAuthState {
  workspaceId: string;
  returnTo: string;
  popup: boolean;
}

function mac(payload: string): string {
  return crypto
    .createHmac("sha256", env.credentialKey || env.googleClientSecret)
    .update(payload)
    .digest("base64url");
}

function signState(state: OAuthState): string {
  const payload = JSON.stringify({ ...state, at: Date.now() });
  const encoded = Buffer.from(payload).toString("base64url");
  return `${encoded}.${mac(payload)}`;
}

const STATE_TTL_MS = 15 * 60 * 1000;

export function verifyState(state: string): OAuthState | null {
  const [encoded, signature] = state.split(".");
  if (!encoded || !signature) return null;

  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  // Constant time: a byte-at-a-time comparison leaks the signature to anyone
  // willing to retry, which is the whole forgery this is here to prevent.
  const a = Buffer.from(signature);
  const b = Buffer.from(mac(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(payload) as OAuthState & { at?: number };
    if (!parsed.workspaceId || !parsed.at) return null;
    if (Date.now() - parsed.at > STATE_TTL_MS) return null;
    return {
      workspaceId: parsed.workspaceId,
      returnTo: parsed.returnTo || "/integrations",
      popup: !!parsed.popup,
    };
  } catch {
    return null;
  }
}

export function authorizeUrl(state: OAuthState): string {
  const params = new URLSearchParams({
    client_id: env.googleClientId,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: SCOPE,
    // Without BOTH of these Google returns no refresh token on a repeat
    // authorization, and the integration silently stops working an hour later
    // when the first access token expires.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: signState(state),
  });
  return `${OAUTH_AUTH}?${params}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(OAUTH_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json().catch(() => ({}))) as TokenResponse;
}

/** Finish the handshake and store the refresh token for this workspace. */
export async function completeConnect(workspaceId: string, code: string): Promise<void> {
  const token = await tokenRequest({
    code,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    redirect_uri: callbackUrl(),
    grant_type: "authorization_code",
  });
  if (!token.refresh_token) {
    throw new Error(
      token.error_description ??
        token.error ??
        "Google returned no refresh token — the app must request offline access.",
    );
  }

  const tokens: StoredTokens = {
    refreshToken: token.refresh_token,
    accessToken: token.access_token,
    expiresAt: token.expires_in ? Date.now() + token.expires_in * 1000 : undefined,
  };

  /*
   * PERSIST FIRST, LOOK UP SECOND — and never the other way round.
   *
   * This used to discover the account and location before saving, and treat a
   * failure there as a failed connection. It is not one. By this line the user
   * has already approved the consent screen and Google has already issued a
   * refresh token: authentication SUCCEEDED. What can still fail is the very
   * next call, for reasons that have nothing to do with the handshake — the
   * Business Profile APIs not enabled on the project yet, the access request
   * not approved, or simply an account that manages no listing.
   *
   * Throwing there discarded a valid refresh token, left the workspace
   * disconnected, and told the user "authentication failed" — naming the one
   * step that had actually worked. Now the grant is banked immediately and
   * discovery is best-effort; `resolveState` retries it on every later call and
   * reports precisely what is missing.
   */
  await saveCredential(workspaceId, PROVIDER, tokens);

  try {
    const resolved = await discoverLocation(tokens);
    if (resolved.accountName) {
      await saveCredential(workspaceId, PROVIDER, { ...tokens, ...resolved });
    }
  } catch (err) {
    // Worth seeing in the log, never worth failing the connection over.
    console.error("[business-profile] connected, but location lookup failed:", err);
  }
}

export async function disconnect(workspaceId: string): Promise<void> {
  await deleteCredential(workspaceId, PROVIDER);
}

/**
 * A usable access token, refreshing when it is close to expiry.
 *
 * The 60-second margin exists because a token that passes the check and then
 * expires mid-request fails the call, not the check — and for a review reply
 * that means a workflow run charged and lost.
 */
async function accessTokenFor(workspaceId: string, tokens: StoredTokens): Promise<string | null> {
  if (tokens.accessToken && tokens.expiresAt && tokens.expiresAt - Date.now() > 60_000) {
    return tokens.accessToken;
  }
  const refreshed = await tokenRequest({
    refresh_token: tokens.refreshToken,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    grant_type: "refresh_token",
  });
  if (!refreshed.access_token) return null;

  await saveCredential(workspaceId, PROVIDER, {
    ...tokens,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
  });
  return refreshed.access_token;
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

async function call<T>(token: string, url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    const message = body.error?.message ?? `Business Profile API ${res.status}`;
    // 403 here is overwhelmingly the access request, not a permission the user
    // can fix, so say which one it is rather than "forbidden".
    throw new Error(
      res.status === 403
        ? `${message} — check the Business Profile API access request is approved for this Google Cloud project.`
        : message,
    );
  }
  return body;
}

/** Bare access token flow used only during connect, before anything is stored. */
async function freshToken(tokens: StoredTokens): Promise<string | null> {
  if (tokens.accessToken) return tokens.accessToken;
  const refreshed = await tokenRequest({
    refresh_token: tokens.refreshToken,
    client_id: env.googleClientId,
    client_secret: env.googleClientSecret,
    grant_type: "refresh_token",
  });
  return refreshed.access_token ?? null;
}

async function discoverLocation(
  tokens: StoredTokens,
): Promise<{ accountName?: string; locationName?: string }> {
  const token = await freshToken(tokens);
  if (!token) return {};

  const accounts = await call<{ accounts?: { name?: string }[] }>(
    token,
    `${ACCOUNTS}/accounts`,
  );
  const accountName = accounts.accounts?.[0]?.name;
  if (!accountName) return {};

  // `readMask` is required — omitting it is a 400, not a default.
  const locations = await call<{ locations?: { name?: string }[] }>(
    token,
    `${INFORMATION}/${accountName}/locations?readMask=name,title&pageSize=100`,
  );
  const locationName = locations.locations?.[0]?.name;
  return { accountName, locationName: locationName ?? undefined };
}

export interface BusinessReview {
  reviewId: string;
  reviewer: string;
  /** 1–5, or null when Google sends the enum it cannot map. */
  rating: number | null;
  comment: string;
  createdAt: string | null;
  /** The owner's existing reply, when there is one. */
  reply: string | null;
}

const STAR_WORDS: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

interface RawReview {
  reviewId?: string;
  starRating?: string;
  comment?: string;
  createTime?: string;
  reviewer?: { displayName?: string };
  reviewReply?: { comment?: string };
}

function toReview(raw: RawReview): BusinessReview {
  return {
    reviewId: String(raw.reviewId ?? ""),
    reviewer: raw.reviewer?.displayName ?? "A customer",
    // Google sends words ("FIVE"), not digits. Anything unrecognised is null
    // rather than 0 — a review with no readable rating is not a zero-star one,
    // and an AI reply drafted against "0 stars" apologises to a happy customer.
    rating: STAR_WORDS[String(raw.starRating ?? "")] ?? null,
    comment: raw.comment ?? "",
    createdAt: raw.createTime ?? null,
    reply: raw.reviewReply?.comment ?? null,
  };
}

/** State a caller can act on without knowing about tokens. */
export type BusinessProfileFailure =
  | "unconfigured"
  | "not_connected"
  | "no_location"
  | "expired"
  /** Authorized, but Google refused the lookup — usually project setup. */
  | "unavailable";

export type BusinessProfileState =
  | { ok: true; token: string; account: string; location: string }
  /** `detail` carries Google's own words when it said something useful. */
  | { ok: false; reason: BusinessProfileFailure; detail?: string };

/**
 * Everything one call needs, resolved once.
 *
 * Returns a REASON rather than null for each way this can be unavailable,
 * because the four mean completely different things to a user: nobody set up
 * the app, this workspace never connected, they connected but own no listing,
 * or their grant was revoked. Collapsing them is how an integration ends up
 * telling everyone to "reconnect" when the real answer is "ask your admin".
 */
export async function resolveState(workspaceId: string): Promise<BusinessProfileState> {
  if (!businessProfileConfigured) return { ok: false, reason: "unconfigured" };

  const tokens = await readCredential<StoredTokens>(workspaceId, PROVIDER);
  if (!tokens?.refreshToken) return { ok: false, reason: "not_connected" };

  const token = await accessTokenFor(workspaceId, tokens);
  if (!token) return { ok: false, reason: "expired" };

  let { accountName, locationName } = tokens;
  if (!accountName || !locationName) {
    try {
      const found = await discoverLocation({ ...tokens, accessToken: token });
      accountName = found.accountName;
      locationName = found.locationName;
      if (accountName && locationName) {
        await saveCredential(workspaceId, PROVIDER, { ...tokens, accountName, locationName });
      }
    } catch (err) {
      // Google answered, and said no. That is a different problem from "this
      // account owns no shops", and the two need different advice: one is a
      // project setting the operator fixes, the other means signing in with a
      // different Google account. Collapsing them sends people to the wrong
      // place, so Google's own message is carried through.
      return { ok: false, reason: "unavailable", detail: (err as Error).message };
    }
  }
  if (!accountName || !locationName) return { ok: false, reason: "no_location" };

  return { ok: true, token, account: accountName, location: locationName };
}

/**
 * Recent reviews for the connected location, newest first.
 *
 * `locationName` from the Business Information API is already
 * `locations/12345`, while the v4 reviews path wants it nested under the
 * account — hence the join rather than a bare interpolation.
 */
export async function listReviews(
  workspaceId: string,
  limit = 20,
): Promise<{ reviews: BusinessReview[] } | { error: string }> {
  const state = await resolveState(workspaceId);
  if (!state.ok) return { error: stateMessage(state.reason, state.detail) };

  const body = await call<{ reviews?: RawReview[] }>(
    state.token,
    `${REVIEWS}/${state.account}/${state.location}/reviews?orderBy=updateTime%20desc&pageSize=${Math.min(limit, 50)}`,
  );
  return { reviews: (body.reviews ?? []).map(toReview) };
}

/**
 * Post (or replace) the owner's public reply to one review.
 *
 * PUT, not POST: Google models the reply as a singleton sub-resource, so the
 * same call creates the first reply and edits an existing one. There is
 * exactly one owner reply per review and no way to have two.
 */
export async function replyToReview(
  workspaceId: string,
  reviewId: string,
  comment: string,
): Promise<{ ok: true } | { error: string }> {
  const state = await resolveState(workspaceId);
  if (!state.ok) return { error: stateMessage(state.reason, state.detail) };

  const text = comment.trim();
  if (!text) return { error: "A reply cannot be empty." };

  await call(
    state.token,
    `${REVIEWS}/${state.account}/${state.location}/reviews/${encodeURIComponent(reviewId)}/reply`,
    { method: "PUT", body: JSON.stringify({ comment: text }) },
  );
  return { ok: true };
}

export function stateMessage(reason: BusinessProfileFailure, detail?: string): string {
  switch (reason) {
    case "unconfigured":
      return "Google Business Profile is not set up on this deployment yet.";
    case "not_connected":
      return "Connect Google Business Profile on the Integrations page first.";
    case "no_location":
      return "That Google account manages no business listings — connect the account that owns the listing on Google Maps.";
    case "expired":
      return "The Google Business Profile connection expired — reconnect it on the Integrations page.";
    case "unavailable":
      return detail
        ? `Google refused the Business Profile lookup: ${detail}`
        : "Google refused the Business Profile lookup.";
  }
}
