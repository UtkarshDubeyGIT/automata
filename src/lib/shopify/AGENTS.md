# lib/shopify — the one integration whose OAuth we perform ourselves

Two modules of handshake plus a token store. Everything here exists because
Shopify has **two doors** and Composio only built one of them:

| Door | Starts at | Who exchanges the code | Code involved |
|---|---|---|---|
| "Connect Shopify" inside ZidaneAI | `/integrations` | Composio | `social/composio.ts` — nothing here |
| Shopify App Store install | Shopify's servers | **us** | this folder + `api/shopify/*` |

The second door never touches `backend.composio.dev`, which is the only
redirect URL the Shopify app used to declare. So a store install landed on an
ordinary ZidaneAI page and three of Shopify's automated review checks failed —
`Immediately authenticates after install`, `Provides mandatory compliance
webhooks`, `Verifies webhooks with HMAC signatures`. Those three checks are
what blocked App Store submission, and public distribution (the only kind that
serves many merchants) requires passing review. "Unlisted" hides the listing;
it does not skip the review.

## The trap that costs the most time

**Two HMAC encodings, one secret.** Query strings are **hex** over sorted
`key=value` pairs; webhook bodies are **base64** over the raw bytes. Crossing
them rejects every genuine request and looks exactly like a wrong client
secret. `tests/shopify-oauth.test.ts` pins both, including the assertion that a
hex digest is *not* accepted on a webhook.

**Read webhook bodies as `text()`, never `json()`.** The signature covers the
exact bytes Shopify sent. `JSON.parse` → `JSON.stringify` changes key order and
whitespace and the digest never matches again. There is a test for this.

## Files

- `oauth.ts` — shop-domain validation (anchored at **both** ends; without the
  trailing `$`, `mystore.myshopify.com.attacker.example` matches and we POST
  the client secret to a host the attacker owns), both HMAC verifiers, signed
  state, and the token exchange. `expiring=1` is deliberately not requested —
  see the comment on `exchangeToken`.
- `installs.ts` — `shopify_installs` (migration `20260905130000`), keyed by
  **shop domain** with a nullable `workspace_id`. That nullability is the whole
  design: an App Store install produces a working token before the merchant has
  a ZidaneAI account.
- `webhooks.ts` — the verify-then-parse front half of the compliance route.
- `connect.ts` — hands the token to Composio so every Shopify tool in
  `workflows/registry.ts` keeps working. Field names are read live from
  Composio's schema and matched by shape, never hardcoded.

## Two state TTLs, on purpose

15 minutes for the OAuth leg, 7 days for the claim leg. The claim wait includes
an emailed signup confirmation, and a 15-minute window there would strand a
real, working install with no button anywhere to attach it.

## One compliance endpoint, because the config decides the code

Shopify's new **Dev Dashboard has no compliance webhook fields at all** — the
section does not exist. They are declared in `shopify.app.toml` and pushed with
`shopify app deploy`, and a TOML subscription block takes a list of
`compliance_topics` and a SINGLE `uri`. So all three topics land on
`api/shopify/webhooks/compliance` and branch on `X-Shopify-Topic` (safe to
trust: the header is covered by the signature verified first). A route per
topic was written first and deleted — nothing could point at them.

## `shop/redact` returns 500 on failure — deliberately against house style

`src/app/api/AGENTS.md` says provider webhooks prefer 200 so the provider
doesn't back off. That is right for a charge that cannot be retried into
existence and exactly wrong for an erasure: Shopify's retry is the only thing
that finishes the job.
