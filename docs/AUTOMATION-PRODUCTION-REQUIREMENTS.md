# Automations on the whole Composio catalog — what it would take

Written 2026-08-29. Numbers come from the live Composio catalog read with our
own key (`/tmp` probe against `GET /api/v3/toolkits`), not from memory, and from
Composio's own docs (links at the end).

## The bottom line

Today Automations work against **12 hand-picked apps and 27 hand-written tool
entries** (`src/lib/workflows/registry.ts`). Composio offers **1,431 apps**. The
gap is not "add more entries" — three things have to change shape: how tools are
discovered, how accounts are connected, and how secrets are stored.

The connection maths is the part that decides the size of the job:

| How an app connects | Apps | What it costs us |
|---|---|---|
| Composio's shared login — one tap, nothing to set up | 122 | already works |
| No login at all | 32 | already works |
| The user pastes a key/token from the provider | ~1,205 | ~~a credential form we do not have~~ **built 2026-08-29** |
| Needs our own developer app registered with the provider | ~200 (OAuth2/S2S/OAuth1) | **one registration each, by hand** |

~89% of the catalog could not be connected from our UI at all until 2026-08-29,
when `ensureAuthConfig` stopped refusing key-only toolkits and started
provisioning a credential-free auth config for them (see `selfServeMode` in
`src/lib/social/composio.ts` and `tests/self-serve-auth.test.ts`). What remains
is the ~200 that need a developer app we register by hand.

---

# Part A — Platform work

## A1. Composio account and project

- A separate Composio **project per environment** (production, staging). Auth
  configs, connected accounts, webhook secret and rate limits are all
  project-scoped, and one OAuth app can serve at most one project.
- `COMPOSIO_API_KEY` per environment, stored in the server env only.
- **One webhook URL registered per project** — we already have
  `https://zidaneai.com/api/composio/triggers` — plus its signing secret in
  `COMPOSIO_WEBHOOK_SECRET`, with a rotation runbook.
- A **plan with enough headroom**: rate limits are 2K–10K requests/minute for the
  whole org, shared across tool calls, connection reads and triggers. Browsing a
  1,431-app catalog and running automations for many workspaces will hit this,
  so we need `X-RateLimit-Remaining` tracking, `Retry-After` handling on 429, and
  caching of tool definitions (the catalog cache today is one hour, in-process
  only — it should move to Supabase or Redis so every server process shares it).

## A2. Open the tool catalog (registry → dynamic)

- **Fetch tool schemas at build time instead of hand-writing them.** The registry
  is a hard gate: a slug that is not in it cannot be emitted by the AI builder or
  executed by the engine. For 1,431 apps we need `GET /tools?toolkit_slug=…` on
  demand, cached, with the `required` list and JSON schema read live.
- **Pin the version question.** Reads currently resolve to Composio's frozen
  `00000000_00` snapshot while `execute()` sends `version: "latest"` — the two
  disagree (e.g. `GMAIL_SEND_EMAIL`'s required fields). Pick one for the whole
  path or the editor will validate against a schema that is not the one that runs.
- **Argument UI from schema.** The inspector's key/value text grid cannot express
  arrays, objects or enums. A schema-driven form is needed, or most of the
  catalog's tools are unusable even once connected.
- **Search over 1,431 apps, not a dropdown.** The step picker and the AI builder
  both need retrieval (semantic search over tool descriptions) rather than the
  full catalog in the prompt — the prompt cannot hold it.
- **Keep the placeholder guard.** `isPlaceholder()` exists because a model once
  copied `<repo>` through as a real value and polled GitHub hourly for it. Live
  `argHint`s from Composio are example-shaped, so this guard gets *more*
  important, not less.
- **Read vs write classification.** `kind: "read" | "write"` drives retry policy
  and approval prompts and is hand-set today. Derive it (verb heuristics on the
  slug plus Composio's own metadata) and default to `write` when unsure.

## A3. Connections — three lanes, two of them missing

1. **One tap (122 apps).** Works today.
2. **User-supplied key (~1,205 apps). Done.** `ensureAuthConfig` now provisions
   a credential-free config and Composio's hosted page collects the user's fields
   (`generic_api_key`, `subdomain`, `hostUrl`, …). Verified live against
   Composio: config created (201), hosted link returned, both cleaned up. Still
   open: our own UI should say, per app, *what to fetch and where from* — a key
   alone is rarely enough (BTCPay wants the server URL, Order Desk a store id).
   Apps offering both a login and a key (Klaviyo, Ahrefs, Brevo, Webflow) are
   included: the refusal now reports `keyFallback`, the button relabels to "Add
   key", and the second press connects — consent, never a silent downgrade.
3. **Our own developer app (~200 apps).** These are the only cards still
   labelled "Set up" — `connectVia` on each catalog row now separates them from
   the key-only ones, so "Set up" means "blocked on us" and nothing else. One registration per provider, by hand,
   each with its own review/approval timeline. Redirect URL to register:
   `https://backend.composio.dev/api/v1/auth-apps/add` — **note:** our
   `.env.example` and the error text in `ensureAuthConfig` say
   `https://backend.composio.dev/api/v3/toolkits/auth/callback`. One of the two is
   stale; verify against a live connect before shipping either to a customer.

Also required in this lane:

- **A credential registry that scales past env vars.** `oauth-apps.ts` reads
  `COMPOSIO_OAUTH_<SLUG>_<FIELD>` from the process env. That is fine for six
  apps and unmanageable for two hundred — it needs a database table with
  encrypted values and an admin screen, plus rotation without a redeploy.
- **Per-workspace accounts, not per-install.** Connections are already scoped by
  workspace (`ctx.entityId` is the Composio `user_id`); keep that invariant when
  the catalog opens up, and keep the cache one-way (it may ratchet toward
  "disconnected", never toward "connected").
- **Expiry handling.** `composio.connected_account.expired` already arrives at our
  webhook. It needs to reach the user: a badge on Integrations, and any automation
  depending on that account paused rather than failing hourly in silence.

## A4. Triggers and real time

- **Trigger types are per toolkit and mostly absent.** Only a minority of apps
  publish any; Shopify publishes none, so "when an order arrives" can only ever
  poll. The UI must keep saying which one it got (`trigger_state.realtime.channel`),
  because "real time" means a push for GitHub/Slack/Linear and a Composio-side
  poll for Gmail/Calendar.
- **Managed auth polls no faster than ~15 minutes.** A customer who needs faster
  needs our own OAuth app for that provider. This is a sales-facing fact, not just
  a technical one.
- **Custom-OAuth apps may need a second registration.** When a trigger type has
  `requires_webhook_endpoint_setup: true`, the provider only delivers to a URL
  registered on *our* app — a per-app ingress
  (`https://backend.composio.dev/api/v3.1/webhook_ingress/{toolkit}/{we_…}/trigger_event`)
  must be created and pasted into the provider's dashboard.
- **Resolution must stay strict.** `resolveTriggerType`'s loose word match has to
  remain unique-or-null; the non-unique version once subscribed "when an event is
  added" to calendar *cancellations*.
- **Polling cost.** The hourly sweep currently walks a handful of triggers. At
  catalog scale it is one provider call per active automation per beat — it needs
  batching, per-workspace fairness, and a cap, or the beat's 30s sweep budget
  silently starves the newest automations.

## A5. Running the work

- Keep the exactly-once machinery as is (`claimRun`, idempotency keys off the due
  *slot*, compare-and-swap driving, stale-claim reclaim) — it is the part that is
  already production-grade.
- **Concurrency and isolation** per workspace so one busy tenant cannot consume
  the whole beat or the whole Composio rate budget.
- **Credits/billing per tool call** — pricing today assumes a small fixed catalog;
  a 315-tool Shopify automation changes the cost shape.
- **Failure taxonomy.** Provider 4xx (user's problem: bad key, missing scope,
  revoked token) must read differently from our 5xx. Today an unknown slug
  surfaces as "<app> is not connected", which is misleading.
- **Timeouts.** 30s per Composio call, no retry on writes (a timed-out write may
  already have landed). Unchanged, but must survive the rewrite.

## A6. Safety, trust and support

- **Approval defaults for external actions.** With 1,431 apps, "this step emails
  your customers" has to be inferred, not curated. Default unknown writes to
  human-approval.
- **Scope minimisation and a disclosure page** — what we ask for, per app, and why.
- **Audit log** of every tool call per workspace (who, what, when, result), for
  support and for disputes.
- **Data handling review**: provider data flowing through Composio and our logs
  needs a retention answer and a DPA position before an enterprise customer asks.
- **Provider app reviews** where we register our own app: Meta (ads_read),
  LinkedIn (Community Management for company posting), X, TikTok, Shopify Partner
  — each is a submission with its own lead time, and some are rejections.

## A7. Testing and verification

- `scripts/composio-tools.mjs --verify` diffs the registry against the live
  catalog. Replace it with a **nightly catalog-drift job** once tools are dynamic:
  slugs disappear and required fields change without us choosing to move.
- Extend `service-probe.ts` to a **per-toolkit smoke test** run against a sandbox
  account for the apps we promote in templates.
- Keep the offline tests that a live probe cannot provoke (no retry on writes,
  disconnected account fails before the provider is called, unresolved `{{…}}`
  caught).

## A8. Ops

- The systemd beat (`deploy/systemd/zidane-cron.*`, every 15 min) is the floor for
  scheduled work; nothing about opening the catalog changes it, but sweep volume
  grows with it.
- Migrations needed: encrypted credential store, per-tool audit log, catalog cache
  table. Follow the existing `supabase/migrations/00NN_*` ordering.

---

# Part B — Commerce services that need external setup

Composio lists **55 e-commerce toolkits**. Six connect with one tap (or need no
login at all) and are excluded per the brief:

> Excluded: **Stripe**, **Square**, **Gumroad**, **Shippo**, **Zoho Inventory**
> (all Composio-managed OAuth — one tap), and **Instacart** (no auth at all).

The remaining **49** all need something fetched or registered outside our app.

## B1. Needs a developer app we register with the provider (6)

Composio hosts no shared app for these, so OAuth is impossible until we register
one and store `client_id` + `client_secret`.

| Service | Tools | What we must do | What the user still supplies |
|---|---|---|---|
| Shopify | 315 | App in the Shopify **Partner/Dev Dashboard** (a store-admin "custom app" only ever issues a static token, never OAuth); scopes for products/orders | store subdomain |
| Wix | 139 | App in the **Wix Dev Center** | — (or a site API key instead) |
| NetSuite | 85 | Integration record in NetSuite (client id/secret) | account subdomain |
| Webflow | 59 | App in Webflow workspace settings | — (or a site API token) |
| Whop | 19 | Whop developer app | — (or an API key) |
| Lightspeed Retail X-Series | 7 | Lightspeed developer app | store subdomain |

## B2. Machine-to-machine / dynamic registration (3)

| Service | Tools | Why it is not one tap |
|---|---|---|
| Commerce Layer | 10 | Server-to-server OAuth — user creates an app in Commerce Layer and pastes subdomain + client id + secret |
| Cashfree Payments MCP | 66 | Dynamic client registration (DCR) against a remote MCP server — a flow our connect path does not implement, plus a merchant account |
| Stripe MCP | 12 | Same DCR flow (separate from the ordinary Stripe toolkit, which *is* one tap) |

## B3. More than one field, or a login instead of a key (14)

Each needs a form with several boxes, and the user has to know where each value
lives in the provider's dashboard.

| Service | Tools | User must fetch |
|---|---|---|
| Cloudcart | 150 | store subdomain + API key |
| ProAbono | 64 | API username + password |
| Finerworks | 33 | API key + web token |
| Order Desk | 20 | store id + API key |
| BTCPay Server | 16 | server host URL (usually self-hosted) + API key |
| Starshipit | 15 | API key + subscription secret |
| Keyzy | 14 | API key + account id |
| Payhere | 13 | subdomain + API key |
| Shipday | 12 | API key, or username + password |
| MerchantPro | 10 | shop host URL + username + password |
| Dpd2 | 8 | API key + account id |
| Jungle Scout | 6 | API key + key name |
| Cults | 3 | API key + user id |
| Storeganise | 3 | subdomain + API key |

## B4. A single key or token from the provider's dashboard (26)

Straightforward once a credential form exists — but every one still means the
user leaving our product, creating or finding a key, and pasting it back.

**Baselinker** (106), **Shipengine** (66), **Fingertip** (60), **Loyverse** (58,
personal access token), **Gift Up!** (44), **Lemon Squeezy** (32), **RedCircle
API** (32), **Printify** (25), **Countdown API** (25), **OpenSea** (24),
**NetLicensing** (21), **Modelry** (14), **Piggy** (14), **Gelato** (13),
**Goody** (13), **NMKR Studio** (11), **Appointo** (11), **Recurly** (10),
**Payhip** (9), **Bestbuy** (8), **ASIN Data API** (6), **Retailed** (6),
**GoodAPI: Plant Trees** (6), **Zylvie** (4), **Storerocket** (2), **Ko-fi** (1).

Several are paid data APIs — ASIN Data, Countdown, RedCircle, Retailed, Jungle
Scout — so "external setup" also means the customer buying a plan before the
automation can run at all.

## B5. What this means for the commerce category as a whole

- **Nothing in commerce beyond the six excluded apps is self-serve today.** Every
  entry above needs either a registration we do once, or a form we do not have.
- **Shopify is the one worth doing first**: 315 tools, the highest-value trigger
  ("new order"), and it is already half-wired — it only lacks the Partner app.
  Note it can never push events (zero trigger types), so its automations poll.
- **The 26 single-key apps are one piece of work, not 26** — the same generic
  credential form unlocks all of them, plus ~1,200 apps outside commerce.

---

## Sources

- [Managed vs custom auth](https://docs.composio.dev/docs/custom-app-vs-managed-app)
- [Creating auth configs programmatically](https://docs.composio.dev/docs/programmatic-auth-configs)
- [Triggers](https://docs.composio.dev/docs/triggers)
- [Custom OAuth webhooks](https://docs.composio.dev/docs/setting-up-triggers/custom-oauth-webhooks)
- [Verifying webhooks](https://docs.composio.dev/docs/webhook-verification)
- [Rate limits](https://docs.composio.dev/reference/rate-limits)
- Live catalog: `GET https://backend.composio.dev/api/v3/toolkits` (1,431 apps,
  read 2026-08-29 with our production key)

---

# Part C — The external accounts to actually go and create

Everything below was checked against the live catalog on 2026-08-29. "One tap
today" means Composio hosts a shared login and the app works right now; it still
appears here when production needs our own app for branding, scopes, quota or
faster polling.

## C1. Blocking — the product already promises these and cannot deliver

| # | Service | Why it matters here | What to create externally | Watch out for |
|---|---|---|---|---|
| 1 | **Shopify** (315 tools) | "Weekly growth digest", "Thank every new customer", "WhatsApp me on every new order" — three shipped templates | App in the **Shopify Partner / Dev Dashboard**, redirect URL pointed at Composio, scopes for orders + products + customers | A store-admin "custom app" only ever issues a static token, never OAuth. Shopify publishes **zero** Composio trigger types, so order automations poll — plan for up to one beat of delay |
| 2 | **Meta Ads** (51 tools) | "Daily Meta Ads report" template; the whole ads-performance surface | **Meta app** (Business type) with `ads_read`, plus **Business Verification** and **App Review** | Composio hosts no shared app — verified. Fallback that unblocks dev today: the toolkit also accepts a user-pasted long-lived access token |
| 3 | **Google Business Profile** | "Reply to Google reviews" — the first template on the page | **Direct Google integration; Composio has no toolkit at all** (re-verified: six plausible slugs, all 404). Needs an OAuth client in the Cloud project holding the approved **Business Profile API access request** | **Client written** (`lib/google/business-profile.ts`, `lib/workflows/native-tools.ts`): reviews, replies and the poll trigger are real once `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set, simulated until then. Access request already approved (user, 2026-09-05); the OAuth client is what remains |
| 4 | **Facebook + Instagram publishing** | Two of the seven social channels on the Integrations page | Same Meta app as #2, with `pages_manage_posts`, `instagram_content_publish`, `pages_read_engagement` — each separately reviewed | One tap today via Composio's shared app, but review is unavoidable before real customers publish |
| 5 | **X (Twitter)** (79 tools) | Listed as a channel, shows "Set up" — cannot connect | **X developer app**, client id + secret | No Composio-hosted app. Posting needs a **paid API tier**; free tier is read-mostly |
| 6 | **TikTok** (9 tools) | Listed as a channel, shows "Set up" | **TikTok developer app** + **Content Posting API audit** | Before the audit passes, posts can only go to private accounts. Also: `dispatch()` rejects TikTok/YouTube posting today — needs a video upload flow regardless |
| 7 | **WhatsApp** (57 tools) | "WhatsApp me on every new order" template | **WhatsApp Business Account (WABA)** + phone number + **approved message templates** | One tap for auth, but the user must supply their WABA id, and the 24-hour reply window means most sends must be templates |
| 8 | **LinkedIn company pages** (24 tools) | Posting as the business, not the person | Our own LinkedIn app with **Community Management API** approved | The shared app only grants `w_member_social`. Also note LinkedIn carousels already bypass Composio and call LinkedIn REST directly |
| 9 | **Google Ads** (22 tools) | Paid-channel reporting alongside Meta Ads | **Google Ads developer token** (Basic access application) + the user's customer id | Answered: the toolkit has 5 tools and NO reporting one, so reporting goes over the Composio proxy (`lib/analytics/ads.ts`). The connection carries the `adwords` scope; the developer token is ours to supply and is the only thing still missing |

## C2. Google, as one piece of work

Gmail (61), Calendar (45), Sheets (45), Drive (77), Docs (41), Analytics (67),
BigQuery (63) and Ads (22) all connect one-tap today through Composio's shared
Google app. For production they should move to **our own Google Cloud project**:

- one OAuth client, branded consent screen, one place to manage scopes;
- **OAuth verification** — and for Gmail's restricted scopes an annual **CASA
  security assessment**, which costs money and takes weeks;
- it also lifts the ~15-minute floor on Composio-managed polling.

Treat it as a single project with many enabled APIs, not eight integrations.

## C3. High value, one tap today, own app later

Nothing blocks these — they work now. Register our own app when branding, scopes
or rate limits start to matter.

**Slack** (158) · **Stripe** (425) · **HubSpot** (244) · **Mailchimp** (272) ·
**Notion** (53) · **GitHub** (871) · **Linear** (46) · **Jira** (97) ·
**Asana** (153) · **Zendesk** (451) · **Intercom** (133) · **Canva** (46) ·
**Pinterest** (24) · **Reddit** (21) · **YouTube** (48) · **Calendly** (52) ·
**Zoom** (90) · **Outlook** (286) · **Microsoft Teams** (157) ·
**Airtable** (24) · **Typeform** (35) · **QuickBooks** (114)

## C4. No shared app — needs our own registration, or a user-pasted key

These show "Set up" in the Integrations grid and stay unconnectable until one of
the two is built.

| Service | Tools | Route in |
|---|---|---|
| Klaviyo | 225 | our own OAuth app, **or** the user's private API key |
| LinkedIn Ads | 28 | our own LinkedIn Marketing app (separate approval from #8) |
| Freshdesk | 178 | user's subdomain + API key |
| Brevo | 21 | our own app, or user's API key |
| Ahrefs | 40 | our own app, or user's API key |
| Razorpay | 42 | our own app, or user's key id + secret |
| Xero | 53 | our own OAuth app |
| Webflow | 59 | our own app, or user's site token |

## C5. Key-only services — one credential form unlocks all of them

No developer app anywhere. The user pastes a key; we only need the form.

**PostHog** (503, + subdomain) · **SendGrid** (359) · **ElevenLabs** (155) ·
**HeyGen** (71) · **Resend** (62) · **SerpApi** (48) · **Amplitude** (54) ·
**Mixpanel** (43, username + password) · **Semrush** (37) · **Firecrawl** (29) ·
**Telegram** (18) · **Exa** (17) · **Perplexity AI** (9) · **Tavily** (5)

## C6. Not Composio at all — already wired, keep on the list

`Supabase` (auth + data) · `OpenAI` (content and reasoning) · `Stripe` (our own
billing, separate from the Stripe toolkit) · `Resend` (signup email; sender
domain must be verified) · `Higgsfield` (video) · `Firecrawl` (onboarding site
analysis).

## C7. Suggested order

1. **Shopify Partner app** — biggest catalogue, three templates depend on it, no review needed for a dev app.
2. **The generic credential form** — unblocks all of C5 and ~1,200 apps in one go.
3. **Meta app + Business Verification** — start early, it is the longest queue, and it covers Ads, Facebook, Instagram and WhatsApp at once.
4. **Google Cloud project** — then move the eight Google toolkits onto it.
5. ~~**Google Business Profile API client**~~ — written 2026-09-05. Only the OAuth client id/secret remain.
6. **X and TikTok apps** — needed before those two channel cards stop saying "Set up".
7. **LinkedIn Community Management** — apply as soon as company-page posting is on the roadmap; approval is slow and not guaranteed.
