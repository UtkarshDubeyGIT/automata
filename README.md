# Automata

Automata is a standalone, AI-first workflow automation SaaS. The platform replicates the full workflow and automation engine from GrowthOS, including visual canvas editing, natural-language workflow generation, 12+ quick-start templates, curated integrations through Composio, Firecrawl web scraping, Twilio WhatsApp notifications, Shopify integration, Google Business Profile reviews, durable background execution, approvals, run journals, workspace roles, credit billing, Stripe subscriptions, and schedule/webhook triggers.

The repository is independent from GrowthOS. `src/config/brand.ts` centralizes the working name so a later rename does not touch product logic.

## Run locally

Requirements: Node 22, npm, and a Supabase project (or Docker for Supabase local development).

```bash
cp .env.example .env.local
npm install
npm run dev
```

Without Supabase keys, the marketing site and product shell run in preview mode. Live run endpoints validate credentials and return clean setup notices when external API keys are missing.

## Configure Supabase

1. Create a fresh Supabase project.
2. Copy its Project URL, publishable key, and secret key into `.env.local`.
3. Apply migrations in `supabase/migrations/` (including `20260903100000_whatsapp_workflow_reminders.sql`, `20260903120000_workspace_provider_credentials.sql`, and `20260905130000_shopify_installs.sql`).
4. In Auth URL Configuration, set the site URL and allow `https://YOUR_DOMAIN/auth/callback`.
5. Enable Email/Password and Google. Add the Google credentials in Supabase Auth.

The migrations enable RLS on every public table, use explicit grants, create an owner workspace on signup, make published workflow versions immutable, protect the last owner, and keep service-only records inaccessible to browser roles.

## Provider setup

- **Composio:** set `COMPOSIO_API_KEY`. Automata uses the workspace UUID as Composio's `user_id`, preserving tenant isolation. Curated apps use existing or managed auth configs.
- **OpenAI:** set `OPENAI_API_KEY`; supports GPT-5.6/5.5 reasoning models as well as fallback models.
- **Firecrawl:** set `FIRECRAWL_API_KEY` for web scraping, searching, and URL content extraction nodes.
- **Twilio (WhatsApp & SMS):** set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, and optional `TWILIO_VERIFY_SERVICE_SID` for SMS OTP verification and WhatsApp workflow reminder delivery.
- **Google Business Profile:** set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` for Google Reviews sync and business profile automation.
- **Shopify:** set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` for direct Shopify App Store and merchant store connections.
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

418 automated tests verify end-to-end workflow compilation, execution, error boundaries, secret handling, webhooks, and integrations.
