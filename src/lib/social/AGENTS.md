# Social

Composio-backed integration layer: connecting toolkits (X/LinkedIn/TikTok/Meta/etc,
really ~1000 of Composio's catalog), publishing posts, and receiving real-time trigger
events. Reached from `src/app/api/integrations/{connect,callback,catalog}`, `/api/scheduler`,
`/api/composio/triggers`, `/api/cron`, the goal layer (`src/lib/goals/execute.ts`,
`evidence.ts`), and the workflow engine (`src/lib/workflows/*`). Client components get
their channel metadata from **`platforms.ts`**, not from `composio.ts` — see below.

## platforms.ts is the client-safe half, and the split is load-bearing

`platforms.ts` holds the VOCABULARY — `Platform`, `PLATFORMS`, `PlatformMeta`,
`CHANNEL_NAME`, `SLUG_RE`, `normalizeSlug`, `platformMeta`, `toolkitLogo`,
`CATALOG_CATEGORIES`. No `env`, no key, no network. `composio.ts` imports and re-exports
all of it, so every pre-existing caller still resolves, but new code should import the
narrow module.

It was one file until seven `"use client"` components (Integrations page, workflow canvas,
inspector, step picker, approval card, workflow logo, connect-apps) and five modules
documented as *pure* (`workflows/validate.ts`, `apps.ts`, `preview.ts`, `display.ts`,
`blocks.ts`) each wanted one lookup table or one `normalizeSlug` — and inherited the
~1200-line API client, the OAuth handshake and `@/lib/env` to get it. That is the same
trap `src/lib/workflows/AGENTS.md` describes under `apps.ts`: types resolve, `tsc
--noEmit` stays green, and the cost lands in the browser bundle.

`tests/pure-modules.test.ts` walks the import graph and fails on it now, so the rule is
checked rather than remembered. The rule for `platforms.ts` itself: it may not import
`@/lib/env`, a Supabase client, or anything that does. A constant that needs a key is not
a constant.

## composio.ts vs composio-triggers.ts

- **composio.ts** owns everything synchronous/pull: the toolkit catalog, auth-config
  provisioning, connect/list/disconnect, and `post()` (publish). `socialProvider` (a
  `ComposioProvider` singleton) is the main export server code calls. It re-exports
  `platforms.ts` for compatibility; the metadata itself lives there.
- **composio-triggers.ts** owns the push half: discovering a toolkit's real-time trigger
  types, creating/disabling a trigger instance (`upsertTriggerInstance`/
  `disableTriggerInstance`), and verifying inbound webhook deliveries (`verifyWebhook`,
  HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, constant-time compare, 5-minute replay
  window, fails closed if `COMPOSIO_WEBHOOK_SECRET` is unset). Trigger slugs are resolved
  at runtime via `resolveTriggerType` (exact match, then a loose word-overlap match) —
  never hardcoded, because Composio's catalog names/renames them independently. Consumed
  by `src/lib/workflows/realtime.ts` (toggles the watch alongside a workflow's Active
  switch) and `src/app/api/composio/triggers/route.ts` (the one inbound webhook endpoint
  for every workspace/toolkit — it resolves the workflow from the payload, not the URL).
  This is additive to polling, never a replacement: if no real-time trigger type matches,
  or a required key is missing, `realtime.ts` leaves the workflow on polling and records
  why in `trigger_state.realtime.reason` — the toggle never fails outright.

Both call the same low-level `api()`/`composioApi()` client in composio.ts (30s timeout,
retries only for idempotent reads, 4xx never retried since it's the provider's considered
answer not a blip).

## OAuth / connect flow

1. `POST /api/integrations/connect` (`connect/route.ts`) validates the slug against
   `SLUG_RE`, resolves `ctx.entityId` (the workspace id, used as Composio's `user_id`),
   and calls `socialProvider.connect()`.
2. Inside `connect()`, `ensureAuthConfig(slug, { allowKey })` (composio.ts) picks or
   provisions the Composio "auth config" a connection attaches to. For a toolkit that
   offers OAuth: (1) an existing OAuth config, our own dev app over Composio's shared one;
   (2) create one from our own dev-app credentials (`oauth-apps.ts`) — the *only* way to
   get non-default scopes, e.g. LinkedIn's `w_organization_social` for posting as a company
   page; (3) create one on Composio's shared/managed app, where offered; (4) a config a
   human set up by hand, EXCLUDING any named `growthos-<slug>-key` (see below); (5) if the
   caller passed `allowKey`, a credential-free config so the user can paste their own key;
   (6) otherwise refuse with the exact env vars needed (`needsCredentials: true`), plus
   `keyFallback: true` when step 5 would have worked. For a toolkit with NO OAuth at all,
   the same credential-free config is provisioned without asking — there is no better
   screen being skipped past. That path is what makes the ~1,200 key-only toolkits
   (PostHog, SendGrid, Printify, Telegram) connectable; before it they all threw "create an
   auth config at dashboard.composio.dev", which is our admin panel and not something the
   person pressing Connect can open.

   Three things hold this together and are easy to break:
   - **`allowKey` is consent, not an instruction.** It only ever arrives because the user
     pressed a button labelled "Add key" (`mode: "key"` on the route). Steps 1–4 still run
     first, so registering a dev app later silently upgrades those users to real OAuth.
   - **Our own fallback config is named `growthos-<slug>-key`** precisely so step 4 can
     skip it. Counting it there would turn every later plain Connect into the silent
     downgrade this order exists to prevent — the bug that once made "Connect Shopify" ask
     for an API key.
   - **The cache is keyed by `<slug>` vs `<slug>:key`.** The two questions can resolve to
     different configs and one must never be served for the other.
3. If every connect-time field the toolkit declares (`connected_account_initiation`) has a
   default, `createConnection()` POSTs `connected_accounts` with those values and the user
   lands straight on the provider's OAuth screen. Otherwise — a Shopify subdomain, an API
   key, anything only the user holds — `connected_accounts/link` returns Composio's hosted
   form, which is also the fallback whenever the direct create fails.
   This used to call `dashboard.composio.dev/.../link.submitLink`, a private endpoint
   Composio has since removed; the skip had silently stopped working. Only the branch that
   is actually used creates an account, so a connect no longer leaves an orphan
   INITIALIZING row behind.
4. Provider redirects to `GET /api/integrations/callback?platform=&return=` (`callback/route.ts`).
   Query params are attacker-forgeable, so nothing here trusts `status=` from the URL —
   it re-reads connection state from Composio for the signed-in user's own entity and only
   trusts that.
5. `oauth-apps.ts` is the bring-your-own-app credential source for step 2: env vars follow
   `COMPOSIO_OAUTH_<SLUG>_<FIELD>` (e.g. `COMPOSIO_OAUTH_LINKEDIN_CLIENT_ID`), with the
   required/optional field list read from Composio's live toolkit schema rather than
   hardcoded per provider. A partially-filled set (some but not all required fields) is
   treated as absent, not sent to Composio to fail there.

`listToolkits()` puts a `connectVia` on every catalog row (`connectMethodOf`, pure):
`managed` when Composio hosts the login, we hold the dev app (`hasOwnOAuthApp`, an env
lookup) or nothing needs authorizing; `key` when the user can finish it themselves by
pasting something; `own_app` when only a developer-app registration will do. The
Integrations page renders these as **Connect / Add key / Set up**. The old label was
`managed ? "Connect" : "Set up"`, which put "paste a key, one minute" and "wait for us to
register an app with the provider" behind the same dead-end word. Curated channel cards are
static client data with no live auth schema, so they get the same answer from
`channelMethod()` plus the `ownApps` list `GET /api/integrations/connect` now returns.

`GET /api/integrations/connect` (list) and `integrations-store.ts` implement a
cache-vs-source-of-truth split: Composio is authoritative whenever reachable
(`socialProvider.live`, i.e. `COMPOSIO_API_KEY` set); the `integrations` table is a
workspace-scoped cache used only when Composio is down/unconfigured. `syncConnections`
reconciles the cache to a live listing on every successful read and downgrades rows
Composio no longer reports (revoked/expired) — the cache can only ratchet toward
"disconnected", never toward "connected" on its own. `readCachedIntegrations` additionally
refuses to serve a cached `connected` row that has no `connected_account_id` (an artifact
of an old onboarding bug that seeded rows with no real OAuth handshake behind them) —
except for `SIMULATED_APPS` (currently just `googlebusinessprofile`, defined in
`src/lib/workflows/registry.ts`), which are connected by definition and never get an id.

## Simulated fallback (no API keys)

`socialProvider.live` is `composioConfigured` (`!!COMPOSIO_API_KEY`). With no key:
- `connect()` returns `{ connected: true, simulated: true, accountId: "sim_<slug>" }`
  immediately, no provider round-trip.
- `listConnections()`/`disconnectPlatform()` are no-ops (`[]` / nothing to delete).
- `post()` returns `{ ok: true, externalId: "sim_<timestamp>", simulated: true }` without
  dispatching anywhere.
- `listToolkits()` (catalog) returns an empty page rather than erroring.
- `connect/route.ts` short-circuits `SIMULATED_APPS` members (no Composio toolkit exists
  for them at all, key or no key) before ever calling `socialProvider`.

This is why `publish.ts`'s carousel branch also checks `socialProvider.live` before
routing to the real LinkedIn document API — otherwise an unconfigured install would throw
reaching for a token that doesn't exist instead of simulating like every other channel.

## publish.ts — the scheduler's actual send path

Turns a due `scheduled_posts` row into a real (or simulated) post. Two invariants worth
knowing before touching it:
- **Exactly once**: claims a row with a compare-and-swap (`UPDATE ... WHERE status =
  'scheduled'`) before any provider call, so a cron beat and a manual "Publish" click can't
  both send the same post. A claim un-resolved for `CLAIM_TTL_MS` (15 min) is reclaimed by
  `reclaimStaleClaims` on the next sweep.
- **Never without permission**: a post whose channel isn't connected is left `scheduled`
  (not failed) and reported via `missingChannels` — it publishes on the next sweep once
  the channel connects, rather than being dropped.
- Failures increment `attempts` and retry up to `MAX_ATTEMPTS` (5) before parking the row
  as `failed`; a revoked token no longer retries forever while `scheduled_posts` reports
  nothing wrong.
- All of the above (cap-by-`published_at`, stale-claim reclaim, attempt ceiling) depend on
  columns from `supabase/migrations/0011_publish_tracking.sql`. `hasTracking()` probes for
  them once per process and silently degrades to legacy behavior (cap counted by
  `scheduled_at`, no reclaim, unbounded retries) if that migration hasn't run — it does not
  fail closed.
- LinkedIn carousels are the one format-specific branch: a queued carousel only stays a
  carousel when the channel is LinkedIn and Composio is live; otherwise it falls through to
  the flattened `body` text like every other channel (losing the swipe cards is preferred
  over not posting).

## Carousel path (LinkedIn only)

`carousel-pdf.ts` renders slides to a PDF via Playwright/Chromium (lazily imported — this
module must not pull Chromium into a bundle that never renders anything). `linkedin-document.ts`
then does the actual 3-call LinkedIn REST flow (`initializeUpload` → `PUT` raw PDF bytes →
`POST /rest/posts` referencing the returned document URN) because **Composio's LinkedIn
toolkit has no document-upload tool** — this is the one place in the module that talks to a
vendor's API directly instead of through `tools/execute`. It reuses the OAuth token from the
existing Composio connected account (`linkedinConnectedAccountId`, workspace-scoped with
`user_ids` and filtered to `ACTIVE`). Connected-account credentials are deliberately masked,
so every authenticated LinkedIn REST call goes through `linkedin-proxy.ts`; Composio injects
and refreshes the real token server-side. Never read `state.val.access_token` or send its
redacted placeholder to LinkedIn. `carousel-publish.ts` wires the three together and
is deliberately NOT imported by `composio.ts`, to keep Playwright out of the client bundle
that imports `composio.ts` for metadata (see top).

## Gotchas

- `linkedinCompanyPages()` (composio.ts) — company pages the connected LinkedIn member
  administers, used to let a post publish as a page instead of the member — currently has
  no caller anywhere in `src/app`. Exists as the read side of `options.pageId` support in
  `PostInput`/`publishLinkedInCarousel`, but nothing in the UI surfaces page selection yet.
- Platform ids used everywhere ARE Composio toolkit slugs, not an internal enum — `x` is
  the one legacy alias (`ALIASES` in composio.ts) kept for old UI/DB rows; always go through
  `normalizeSlug`.
- YouTube and TikTok are listed as channels in `PLATFORMS` but `dispatch()` explicitly
  rejects publishing to either ("needs a video upload flow — not supported yet") — connect
  works, posting doesn't.
- `S2S_OAUTH2` is deliberately excluded from `OAUTH_SCHEMES`: it authenticates the app, not
  the user, so it can never stand in for the consent screen a real connection needs.
