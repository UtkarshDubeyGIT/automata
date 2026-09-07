import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { test } from "node:test";

/**
 * The Shopify install flow's trust boundary.
 *
 * Everything here guards a check Shopify's app review runs automatically
 * before a submission is even accepted, and each one failed on this app until
 * the routes under `api/shopify/*` existed. They are worth testing rather than
 * eyeballing because two of them fail in ways that look like success:
 *
 *  - the review robot proves HMAC verification by sending a DELIBERATELY BAD
 *    signature and requiring a 401. An endpoint that accepts everything passes
 *    a manual smoke test perfectly and fails review;
 *  - query signatures are hex and webhook signatures are base64 over the raw
 *    body. Mixing them up rejects every genuine request, which is
 *    indistinguishable from having the wrong client secret.
 *
 * The secret is set before the import because `env.ts` reads `process.env` at
 * module load, so the import has to be dynamic — see tests/AGENTS.md.
 */

const SECRET = "shpss_test_client_secret";
process.env.COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID = "test-client-id";
process.env.COMPOSIO_OAUTH_SHOPIFY_CLIENT_SECRET = SECRET;

const {
  isValidShop,
  normalizeShop,
  signState,
  verifyClaim,
  verifyQueryHmac,
  verifyState,
  verifyWebhookHmac,
} = await import("@/lib/shopify/oauth");
const { mapConnectionFields } = await import("@/lib/shopify/connect");

/** Sign a query the way Shopify does: sorted key=value pairs, hex digest. */
function signedQuery(params: Record<string, string>): URLSearchParams {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const search = new URLSearchParams(params);
  search.set("hmac", createHmac("sha256", SECRET).update(message).digest("hex"));
  return search;
}

test("a store domain must be anchored at both ends", () => {
  assert.equal(isValidShop("mystore.myshopify.com"), true);
  // The suffix attack the anchoring exists for. This value is interpolated
  // into the token-exchange URL, so a match here would POST the app's client
  // secret to a host the attacker controls.
  assert.equal(isValidShop("mystore.myshopify.com.attacker.example"), false);
  assert.equal(isValidShop("attacker.example"), false);
  assert.equal(isValidShop("-bad.myshopify.com"), false);
});

test("a bare subdomain and a full domain both normalize to one canonical shop", () => {
  assert.equal(normalizeShop("mystore"), "mystore.myshopify.com");
  assert.equal(normalizeShop("MyStore.myshopify.com"), "mystore.myshopify.com");
  assert.equal(normalizeShop("  mystore  "), "mystore.myshopify.com");
  assert.equal(normalizeShop("mystore.myshopify.com.attacker.example"), null);
  assert.equal(normalizeShop(""), null);
});

test("a correctly signed install query verifies, and a tampered one does not", () => {
  const query = signedQuery({
    shop: "mystore.myshopify.com",
    timestamp: "1757000000",
    host: "YWRtaW4=",
  });
  assert.equal(verifyQueryHmac(query), true);

  // Swapping the shop after signing is the exact forgery that would otherwise
  // send a merchant, and our client_id, to a store we never verified.
  const forged = new URLSearchParams(query);
  forged.set("shop", "attacker.myshopify.com");
  assert.equal(verifyQueryHmac(forged), false);
});

test("an install query with no hmac at all is refused", () => {
  const bare = new URLSearchParams({ shop: "mystore.myshopify.com" });
  assert.equal(verifyQueryHmac(bare), false);
});

test("webhook signatures are base64 over the raw body", () => {
  const body = JSON.stringify({ shop_domain: "mystore.myshopify.com", shop_id: 1 });
  const good = createHmac("sha256", SECRET).update(body, "utf8").digest("base64");
  assert.equal(verifyWebhookHmac(body, good), true);

  // What Shopify's "Verifies webhooks with HMAC signatures" check actually
  // sends. This assertion is the check.
  assert.equal(verifyWebhookHmac(body, "not-a-real-signature"), false);
  assert.equal(verifyWebhookHmac(body, null), false);

  // The hex digest used for query strings must NOT be accepted here. Getting
  // these two encodings crossed is the common way this endpoint breaks.
  const hex = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  assert.equal(verifyWebhookHmac(body, hex), false);
});

test("a webhook body re-serialized before verifying no longer matches", () => {
  // Why every webhook route reads req.text() and not req.json(): the signature
  // covers the exact bytes, and a JSON round-trip does not preserve them.
  const raw = '{"shop_domain":"mystore.myshopify.com",  "shop_id":1}';
  const signature = createHmac("sha256", SECRET).update(raw, "utf8").digest("base64");
  assert.equal(verifyWebhookHmac(raw, signature), true);
  assert.equal(verifyWebhookHmac(JSON.stringify(JSON.parse(raw)), signature), false);
});

test("state round-trips, and a tampered workspace does not survive it", () => {
  const signed = signState({
    shop: "mystore.myshopify.com",
    workspaceId: "ws-1",
    returnTo: "/integrations",
  });
  assert.deepEqual(verifyState(signed), {
    shop: "mystore.myshopify.com",
    workspaceId: "ws-1",
    returnTo: "/integrations",
  });

  // Rewriting the payload to name someone else's workspace is how an attacker
  // would attach their store — or someone else's — to another account.
  const [encoded] = signed.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  payload.workspaceId = "ws-victim";
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signed.split(".")[1]}`;
  assert.equal(verifyState(forged), null);
});

test("state expires, and the claim leg is given a longer window on purpose", () => {
  const stale = signState({
    shop: "mystore.myshopify.com",
    workspaceId: null,
    returnTo: "/integrations",
  });
  // Rebuild the same token with an old timestamp, signed correctly — this is
  // replay, not forgery, and the TTL is the only thing that stops it.
  const [encoded, signature] = stale.split(".");
  const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  assert.ok(payload.at, "state carries a timestamp");

  const age = (ms: number) => {
    const aged = JSON.stringify({ ...payload, at: Date.now() - ms });
    const mac = createHmac("sha256", SECRET).update(aged).digest("base64url");
    return `${Buffer.from(aged).toString("base64url")}.${mac}`;
  };
  assert.equal(signature.length > 0, true);

  const twoHours = age(2 * 60 * 60 * 1000);
  assert.equal(verifyState(twoHours), null, "the OAuth leg expires in 15 minutes");
  // The merchant may still be confirming a signup email two hours later, and
  // a working install with nowhere to attach is worse than a long window.
  assert.notEqual(verifyClaim(twoHours), null, "the claim leg survives a signup");
  assert.equal(verifyClaim(age(8 * 24 * 60 * 60 * 1000)), null, "but not forever");
});

test("a signed state naming a bogus shop is still refused", () => {
  // Defence against our own past selves: the shop inside a valid signature is
  // interpolated into a URL, so it is re-checked rather than trusted.
  const payload = JSON.stringify({
    shop: "mystore.myshopify.com.attacker.example",
    workspaceId: null,
    returnTo: "/integrations",
    at: Date.now(),
  });
  const mac = createHmac("sha256", SECRET).update(payload).digest("base64url");
  assert.equal(verifyState(`${Buffer.from(payload).toString("base64url")}.${mac}`), null);
});

test("Composio's connect fields are filled by shape, not by hardcoded name", () => {
  const shop = "mystore.myshopify.com";
  const token = "shpat_live_token";

  assert.deepEqual(mapConnectionFields(["shop", "api_key"], shop, token), {
    shop: "mystore",
    api_key: token,
  });
  // A field asking for a domain gets the whole host; one asking for the shop
  // gets the short name. Crossed over, this produces
  // "mystore.myshopify.com.myshopify.com" and every tool call fails.
  assert.deepEqual(mapConnectionFields(["shop_domain", "access_token"], shop, token), {
    shop_domain: shop,
    access_token: token,
  });
  assert.deepEqual(mapConnectionFields(["subdomain", "admin_api_token"], shop, token), {
    subdomain: "mystore",
    admin_api_token: token,
  });
});

test("an unrecognised connect field refuses rather than half-filling", () => {
  // Composio owns this schema and has renamed fields before. A partial map
  // would still create an ACTIVE connection whose every tool call 401s later,
  // pointing nowhere near the cause — so null makes it fail here, loudly.
  assert.equal(
    mapConnectionFields(["shop", "api_key", "some_new_field"], "mystore.myshopify.com", "t"),
    null,
  );
});
