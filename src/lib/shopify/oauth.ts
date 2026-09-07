import crypto from "node:crypto";
import { env, shopifyConfigured } from "@/lib/env";

/**
 * Shopify's OAuth handshake, performed by us rather than by Composio.
 *
 * WHY THIS EXISTS, GIVEN COMPOSIO ALREADY CONNECTS SHOPIFY. There are two
 * doors into a Shopify integration and Composio only built one of them:
 *
 *   1. The merchant is already inside ZidaneAI and presses "Connect Shopify".
 *      Composio drives that: it owns the redirect URL, exchanges the code, and
 *      holds the token. Nothing in this file is involved.
 *   2. The merchant installs from the Shopify App Store. The flow starts on
 *      SHOPIFY's side: it opens the app's configured App URL with a signed
 *      `?shop=` query and expects to be bounced straight to the store's own
 *      permission screen.
 *
 * Door 2 never touches Composio's servers, so before this module existed a
 * store install landed on an ordinary ZidaneAI page and Shopify's automated
 * review check "Immediately authenticates after install" failed — which is
 * what blocked App Store submission. Public distribution is the only kind that
 * serves many merchants, and it requires review; "unlisted" hides the listing
 * but does not skip the review. See docs/INTEGRATION-SETUP-STEPS.md.
 *
 * EVERYTHING INBOUND IS SIGNED WITH THE CLIENT SECRET. Query strings and
 * webhook bodies both arrive over a plain HTTP request that anyone can forge,
 * so the client secret is the only thing separating Shopify from a prober.
 * Two different HMAC encodings, which is a genuine trap rather than trivia:
 * query strings are hex, webhook bodies are base64. Comparing the wrong
 * encoding fails every time and looks exactly like a wrong secret.
 */

/**
 * A store domain, anchored at BOTH ends.
 *
 * The trailing `$` is the whole point. Without it
 * `evil.myshopify.com.attacker.example` matches, and since this value is
 * interpolated into the authorize URL and the token-exchange URL, a match
 * means we would post the app's client secret to a host the attacker owns.
 */
const SHOP_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidShop(shop: string): boolean {
  return SHOP_RE.test(shop);
}

/**
 * Accepts what a human types ("mystore") as well as the full domain, and
 * answers the canonical domain or null.
 *
 * The in-app connect flow asks for the bare subdomain — see the Shopify
 * section of docs/INTEGRATION-SETUP-STEPS.md — so both spellings reach us.
 */
export function normalizeShop(input: string | null | undefined): string | null {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return null;
  const domain = raw.includes(".") ? raw : `${raw}.myshopify.com`;
  return isValidShop(domain) ? domain : null;
}

function secret(): string {
  return env.shopifyClientSecret;
}

/** Constant time, and false rather than a throw on a length mismatch. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Verify the `hmac` on an inbound Shopify query string (install ping and OAuth
 * return both carry one).
 *
 * The message is every parameter EXCEPT `hmac` and `signature`, sorted by key,
 * joined `key=value` with `&`, over the DECODED values — which is what
 * `URLSearchParams` iteration already gives us. Digest is hex.
 */
export function verifyQueryHmac(params: URLSearchParams): boolean {
  if (!shopifyConfigured) return false;
  const presented = params.get("hmac");
  if (!presented) return false;

  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .map(([key, value]) => [key, value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const expected = crypto.createHmac("sha256", secret()).update(message).digest("hex");
  return sameDigest(presented, expected);
}

/**
 * Verify `X-Shopify-Hmac-Sha256` over a webhook's RAW body.
 *
 * Raw, not re-serialized. `JSON.parse` then `JSON.stringify` changes key order
 * and whitespace, and the signature is over the exact bytes Shopify sent — so
 * a route that reads `req.json()` first can never verify anything. Every
 * webhook route here reads `req.text()` for that reason.
 *
 * Digest is base64 here, unlike the hex used on query strings.
 */
export function verifyWebhookHmac(rawBody: string, header: string | null): boolean {
  if (!shopifyConfigured || !header) return false;
  const expected = crypto.createHmac("sha256", secret()).update(rawBody, "utf8").digest("base64");
  return sameDigest(header, expected);
}

// ---------------------------------------------------------------------------
// Signed state — the callback's only trustworthy input
// ---------------------------------------------------------------------------

/**
 * What we carry across the round-trip.
 *
 * `workspaceId` is null on an App Store install, and that is the normal case
 * rather than an error: the merchant found us on Shopify and has no ZidaneAI
 * account yet. The token is parked against the shop and claimed after they
 * sign in — see `installs.ts` and `api/shopify/claim`.
 *
 * Signing is not optional. An unsigned workspace id would let anyone attach
 * THEIR store to SOMEONE ELSE's workspace by editing the URL, and an unsigned
 * `returnTo` is an open redirect.
 */
export interface ShopifyState {
  shop: string;
  workspaceId: string | null;
  returnTo: string;
}

function mac(payload: string): string {
  return crypto.createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function signState(state: ShopifyState): string {
  const payload = JSON.stringify({ ...state, at: Date.now() });
  return `${Buffer.from(payload).toString("base64url")}.${mac(payload)}`;
}

/**
 * 15 minutes for the OAuth round-trip: long enough for a merchant to read a
 * permission screen, short enough that a state string captured from a browser
 * history or a proxy log is useless by the time anyone finds it.
 */
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Seven days for the CLAIM leg, which is a different wait entirely.
 *
 * After an App Store install the merchant has a token but no ZidaneAI account,
 * so the next step is signing up — and this app's signup includes an emailed
 * confirmation. Fifteen minutes would expire while they were reading that
 * email, stranding a real, working install with no button anywhere to attach
 * it. The token is already stored and encrypted by then; what this signs is
 * only the right to name a shop, so a longer window costs little.
 */
const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function verifyState(
  raw: string | null | undefined,
  ttlMs: number = STATE_TTL_MS,
): ShopifyState | null {
  if (!raw || !shopifyConfigured) return null;
  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) return null;

  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  if (!sameDigest(signature, mac(payload))) return null;

  try {
    const parsed = JSON.parse(payload) as ShopifyState & { at?: number };
    if (!parsed.at || Date.now() - parsed.at > ttlMs) return null;
    // A signed-but-malformed shop would still be interpolated into a URL
    // below, so re-check it here rather than trusting our own past self.
    if (!parsed.shop || !isValidShop(parsed.shop)) return null;
    return {
      shop: parsed.shop,
      workspaceId: parsed.workspaceId ?? null,
      returnTo: parsed.returnTo || "/integrations",
    };
  } catch {
    return null;
  }
}

/** A claim token names a shop and nothing else; ownership comes from the session. */
export function verifyClaim(raw: string | null | undefined): ShopifyState | null {
  return verifyState(raw, CLAIM_TTL_MS);
}

// ---------------------------------------------------------------------------
// The two legs
// ---------------------------------------------------------------------------

export function callbackUrl(): string {
  return `${env.appUrl}/api/shopify/callback`;
}

export function authorizeUrl(state: ShopifyState): string {
  const params = new URLSearchParams({
    client_id: env.shopifyClientId,
    scope: env.shopifyScopes,
    redirect_uri: callbackUrl(),
    state: signState(state),
  });
  return `https://${state.shop}/admin/oauth/authorize?${params}`;
}

export interface ShopifyToken {
  accessToken: string;
  scope: string;
}

/**
 * Swap the one-time code for a token.
 *
 * `expiring=1` is deliberately NOT sent. That flag asks Shopify for a
 * short-lived token plus a refresh token, which would make us responsible for
 * a refresh loop for a credential we immediately hand to Composio — and
 * Composio's Shopify toolkit takes a static Admin API token, with nowhere to
 * put a refresh one. The offline token this returns is the same kind of
 * credential a merchant pastes today from their own store admin, which is why
 * the existing tools keep working unchanged.
 */
export async function exchangeToken(shop: string, code: string): Promise<ShopifyToken> {
  if (!isValidShop(shop)) throw new Error(`Refusing token exchange with ${shop}`);

  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: env.shopifyClientId,
      client_secret: env.shopifyClientSecret,
      code,
    }),
  });

  if (!res.ok) {
    // Shopify's body here is short and says which half is wrong (bad code vs
    // bad client secret). Losing it costs an hour of guessing.
    throw new Error(`Shopify token exchange failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token?: string; scope?: string };
  if (!body.access_token) throw new Error("Shopify token exchange returned no access_token");
  return { accessToken: body.access_token, scope: body.scope ?? "" };
}
