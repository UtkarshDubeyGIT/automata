# Automata

Automata is a standalone, AI-first workflow automation SaaS. The MVP includes a visual builder, natural-language drafts, 12 quick-start templates, 13 curated integrations through Composio, real one-call execution, approvals, run journals, workspace roles, credit billing, Stripe subscriptions, and schedule/webhook triggers.

The repository is independent from GrowthOS. `src/config/brand.ts` centralizes the working name so a later rename does not touch product logic.

## Run locally

Requirements: Node 22, npm, and a Supabase project (or Docker for Supabase local development).

```bash
cp .env.example .env.local
npm install
npm run dev
```

Without Supabase keys, the marketing site and product shell run in preview mode. No provider action is simulated: live run endpoints return a configuration error until server keys exist.

## Configure Supabase

1. Create a fresh Supabase project.
2. Copy its Project URL, publishable key, and secret key into `.env.local`.
3. Apply `supabase/migrations/20260831152749_automata_mvp.sql` with `supabase db push` after linking the project.
4. In Auth URL Configuration, set the site URL and allow `https://YOUR_DOMAIN/auth/callback`.
5. Enable Email/Password and Google. Add the Google credentials in Supabase Auth.

The migration enables RLS on every public table, uses explicit grants, creates an owner workspace on signup, makes published workflow versions immutable, protects the last owner, and keeps service-only records inaccessible to browser roles.

## Provider setup

- **Composio:** set `COMPOSIO_API_KEY`. Automata uses the workspace UUID as Composio's `user_id`, preserving tenant isolation. Curated apps use existing or managed auth configs; providers without managed OAuth require an auth config in Composio.
- **OpenAI:** set `OPENAI_API_KEY`; optional model overrides are in `.env.example`. AI drafts insert approvals before external writes unless the user explicitly requests unattended writes.
- **Stripe:** create monthly and annual recurring prices for Pro and Team, set all four price IDs, then send Stripe webhooks to `/api/billing/webhook`. Subscribe to checkout-session and customer-subscription events.
- **Email:** set Resend credentials to send approval/failure mail. In-app notices work without Resend.

## Execution modes

- **Run once:** `POST /api/workflows/:id/run` executes immediately and returns the actual result. It pauses truthfully at approvals.
- **Webhook:** a webhook workflow receives its one-time key when created. Send JSON to `/api/workflows/:id/webhook` using `x-automata-webhook-key` and an optional stable `x-automata-delivery-id`.
- **Schedules on Vercel:** `vercel.json` calls `/api/cron`; Vercel supplies `Authorization: Bearer $CRON_SECRET`.
- **Schedules on a VM:** `docker compose up -d` runs both the web process and the durable schedule worker.

Every module is journaled. Connected app and HTTP successes cost one credit; AI/image modules use measured provider credits; control-flow and failures cost zero. Idempotency keys prevent duplicate runs and ledger charges.

## Quality checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

See [Architecture](docs/ARCHITECTURE.md) and [Launch checklist](docs/LAUNCH_CHECKLIST.md).
