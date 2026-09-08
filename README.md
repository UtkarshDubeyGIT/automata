# Automata

Automata is a standalone, AI-first workflow automation SaaS. The platform replicates the full workflow and automation engine from GrowthOS, including visual canvas editing, natural-language workflow generation, quick-start templates, the live Composio integration catalog, Firecrawl web scraping, Twilio WhatsApp notifications, Shopify integration, Google Business Profile reviews, durable background execution, approvals, run journals, workspace roles, credit billing, Stripe subscriptions, and schedule/webhook triggers.

The Automation and Workflows screens are ported from Zidane AI (`growthos`), including the four automation tabs, canvas/inspector, run journals, connection setup, and integration catalog. `src/app/globals.css` carries its complete design tokens. Sora, Hanken Grotesk, and Geist Mono are self-hosted in `src/app/fonts`; public/auth styles live separately in `marketing.css` so they cannot override product controls.

`/app` opens Automations. `/app/workflows?tab=workflows`, `?tab=runs`, and `?tab=attention` open the corresponding tabs; `/app/integrations`, `/app/settings`, and `/app/billing` use the same shell and real API state. Old `/workflows`, `/integrations`, `/app/runs`, and `/app/approvals` links redirect to these routes. Automata branding and its Free/Pro/Team price book are retained.

## Run locally

Requirements: Node 22, npm, and a Supabase project (or Docker for Supabase local development). Video workflows also need FFmpeg/ffprobe on `PATH` and Chromium (`npx playwright install chromium`). The Docker image installs these runtime dependencies and runs the app and worker as a non-root user.

```bash
cp .env.example .env.local
npm install
npm run dev
```

Without Supabase keys, the marketing site and product shell run in preview mode. Persisting/editing workflows requires an authenticated workspace. Provider-dependent actions show setup or demo status when credentials are missing; a visual preview does not establish a live connection.

## Configure Supabase

1. Create a fresh Supabase project.
2. Copy its Project URL, publishable key, and secret key into `.env.local`.
3. Apply all migrations in `supabase/migrations/` in filename order. The determinism migration bootstraps runtime compatibility for a fresh install. Existing Automata databases also need `20260908145225_workflow_runtime_compatibility.sql`, which adds the copied engine’s storage and credit/integration tables. SQL migrations are repository artifacts; local UI development does not apply them to a hosted project.
4. In Auth URL Configuration, set the site URL and allow `https://YOUR_DOMAIN/auth/callback`.
5. Enable Email/Password authentication.

The migrations enable RLS on every public table, use explicit grants, create an owner workspace on signup, make published workflow versions immutable, protect the last owner, and keep service-only records inaccessible to browser roles.

## Provider setup

- **Composio:** set `COMPOSIO_API_KEY`. Automata uses the workspace UUID as Composio's `user_id`, preserving tenant isolation. Curated apps use existing or managed auth configs.
- **OpenAI:** set `OPENAI_API_KEY`; supports GPT-5.6/5.5 reasoning models as well as fallback models.
- **Firecrawl:** set `FIRECRAWL_API_KEY` for web scraping, searching, and URL content extraction nodes.
- **Twilio (WhatsApp & SMS):** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, and optional `TWILIO_VERIFY_SERVICE_SID` for SMS OTP verification and WhatsApp workflow reminder delivery.
- **Google Business Profile:** set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for Google Reviews sync and business profile automation.
- **Shopify:** set `COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID` and `COMPOSIO_OAUTH_SHOPIFY_CLIENT_SECRET` for direct Shopify App Store and merchant store connections.
- **Video:** set `HIGGSFIELD_API_KEY`, `HIGGSFIELD_SECRET`, and `OPENAI_API_KEY`; provide Supabase service credentials and the `videos` storage bucket. Keep `npm run worker` running for queued renders and workflow resumption.
- **Encryption:** set `CREDENTIAL_ENCRYPTION_KEY` (32-byte hex string) to encrypt workspace provider credentials using AES-256-GCM.
- **Stripe:** set price IDs and `STRIPE_SECRET_KEY` for Pro and Team subscriptions; webhooks land at `/api/billing/webhook`.
- **Cron:** set `CRON_SECRET` for securing background cron beats at `/api/cron`.

## Execution modes

- **Run once:** `POST /api/workflows/:id/run` executes immediately and returns the actual result. It pauses truthfully at approvals.
- **Webhook:** a webhook workflow receives its one-time key when created. Send JSON to `/api/workflows/:id/webhook` using `x-automata-webhook-key` and an optional stable `x-automata-delivery-id`. Webhook payload samples are captured and inspectable in the canvas.
- **Schedules on Vercel:** `vercel.json` calls `/api/cron`; Vercel supplies `Authorization: Bearer $CRON_SECRET`.
- **Schedules on a VM:** `npm run worker` runs the durable schedule and build worker.

Every module is journaled. Connected app and HTTP successes cost one credit; AI/image modules use measured provider credits; control-flow and failures cost zero. Idempotency keys prevent duplicate runs and ledger charges.

## Quality checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

The test suite covers workflow compilation/execution, durable builds, approvals, provider contracts, authentication, credits, settings, and schema compatibility. Browser verification can use intercepted API fixtures to exercise canvas edits without modifying a connected workspace. Paid provider calls and hosted migration application are separate operational checks.

After installing Chromium, `AUTOMATA_BROWSER_TESTS=1 npm test` also runs the isolated capture-network regression against local fixture servers. It checks public-page recording and blocks private redirects, embedded requests, and WebSockets without contacting paid providers. See [runtime schema verification](docs/runtime-schema-verification.md) for the isolated migration checks.
