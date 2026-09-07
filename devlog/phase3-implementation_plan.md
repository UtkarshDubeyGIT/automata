# Phase 3 Implementation Plan: Replicate GrowthOS Workflow Automation in Automata

## Overview
This phase replicates the full workflow and automation engine from GrowthOS into Automata. Automata is positioned as a dedicated, standalone AI-first workflow automation platform. While a foundational port was initiated previously, key runtime systems, integrations (Firecrawl, WhatsApp reminders, Google Business Profile native tools, Shopify OAuth & compliance, dynamic catalog tool loading), robust editor auto-save synchronization, database tables, tests, and environment configurations remained in GrowthOS.

This phase ports all missing workflow and automation features, routes, libraries, migrations, tests, and environment keys to make Automata a fully functioning, directly replicated automation suite.

---

## 1. Scope of Changes

### A. Environment Configuration (`.env.local`, `.env.example`, `src/lib/env.ts`)
- **Copy all active keys from `growthos/.env.local` to `automata/.env.local`**:
  - Supabase credentials (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`)
  - OpenAI credentials (`OPENAI_API_KEY`, `OPENAI_MODEL=gpt-5.6-terra`, `OPENAI_TRENDS_MODEL=gpt-5.5`)
  - Twilio / WhatsApp credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`, `TWILIO_WHATSAPP_SANDBOX`, `TWILIO_VERIFY_SERVICE_SID`)
  - Composio credentials & trigger signing secret (`COMPOSIO_API_KEY`, `COMPOSIO_WEBHOOK_SECRET`)
  - Composio Shopify app OAuth credentials (`COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID`, `COMPOSIO_OAUTH_SHOPIFY_CLIENT_SECRET`, `COMPOSIO_OAUTH_SHOPIFY_SCOPES`)
  - Firecrawl & Linkup credentials (`FIRECRAWL_API_KEY`, `LINKUP_API_KEY`)
  - Google Business Profile & OAuth credentials (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ADS_DEVELOPER_TOKEN`)
  - Security & Cron secrets (`CREDENTIAL_ENCRYPTION_KEY`, `CRON_SECRET`)
  - Higgsfield video generation credentials (`HIGGSFIELD_API_KEY`, `HIGGSFIELD_SECRET`, `HIGGSFIELD_BASE_URL`)
  - Stripe & Resend keys
- **Update `automata/.env.example`** with full documentation and defaults.
- **Update `automata/src/lib/env.ts`** to expose all configuration properties and exported booleans (`twilioConfigured`, `firecrawlConfigured`, `googleBusinessConfigured`, `shopifyConfigured`, etc.).

### B. Integration Libraries (`src/lib/`)
- Port `src/lib/credentials.ts`: AES-256-GCM encryption/decryption of workspace provider tokens.
- Port `src/lib/setup-notice.ts`: User-actionable setup error notices.
- Port `src/lib/integrations/firecrawl.ts`: Scrape, search, map, crawl, agent operations with status polling.
- Port `src/lib/google/business-profile.ts`: Google Business Profile OAuth, reviews listing and replies.
- Port `src/lib/shopify/`:
  - `connect.ts`, `installs.ts`, `oauth.ts`, `webhooks.ts`, `AGENTS.md`.
- Port `src/lib/whatsapp/`:
  - `core.ts`, `twilio.ts`, `service.ts`.
- Port `src/lib/analytics-external.ts` & analytics helpers for search console / GA4 if referenced.

### C. Workflow Engine & Library Updates (`src/lib/workflows/`)
- `native-tools.ts`: Google Business Profile native reviews actions.
- `steps.ts`:
  - `firecrawl` step execution with `Await` state.
  - `whatsapp_reminder` step execution with outbox queuing.
  - `native-tools` dispatch for unhosted/custom tools before Composio.
  - `tool_spec` support in `getTool(tool, step.tool_spec)`.
  - Expanded `workflowAIContext` (12k chars, untrusted input formatting).
  - YouTube video step checks.
- `blocks.ts`:
  - Register `firecrawl` and `whatsapp_reminder` blocks with complete UI schemas and defaults.
- `runtime.ts`:
  - Add `kickRun` for immediate fast-start execution of webhook triggers.
  - Add `pollFirecrawlJob` to `resumeAwaiting`.
  - Add WhatsApp failure and approval alert notifications.
  - Update `hadRealSideEffect`.
- `sweep.ts`:
  - Integrate `nativePoll` and `executeNativeTool` for Google review triggers.
- `registry.ts`:
  - Add Search Console, Google Analytics, Google Ads, YouTube, Firecrawl tool definitions.
  - Prevent angle bracket placeholders from leaking into AI prompt hints.
- `builder.ts`:
  - YouTube video rules and prompt enhancements.
- `templates.ts`:
  - Add `meeting-whatsapp-summary` template.
- `types.ts`:
  - Include `AwaitingState` (`"video" | "firecrawl"`), trigger sample secrets, and realtime channels.
- `edit.ts` & `layout.ts`:
  - Use `buildFlows` to lay out and visualize disconnected/stray nodes on the canvas.
- `webhook-receiver.ts`:
  - Fast-start execution via `after(() => kickRun(...))`.
- `interpolate.ts`:
  - Flattening of scalar numeric metrics rows.

### D. API Routes (`src/app/api/`)
- `src/app/api/integrations/firecrawl/route.ts`
- `src/app/api/integrations/catalog/tools/route.ts`
- `src/app/api/integrations/google-business/route.ts`
- `src/app/api/integrations/google-business/callback/route.ts`
- `src/app/api/shopify/install/route.ts`
- `src/app/api/shopify/callback/route.ts`
- `src/app/api/shopify/webhooks/compliance/route.ts`
- `src/app/api/shopify/claim/route.ts`
- `src/app/api/whatsapp/test/route.ts`
- `src/app/api/whatsapp/verify/start/route.ts`
- `src/app/api/whatsapp/verify/check/route.ts`
- `src/app/api/whatsapp/status/route.ts`
- `src/app/api/whatsapp/profile/route.ts`

### E. Workflow UI Canvas & Editor (`src/app/(app)/workflows/` & `src/app/app/workflows/`)
- Port `whatsapp-node-status.tsx`.
- Update `canvas.tsx` with WhatsApp alert badge and stray node visualization.
- Update `inspector.tsx` with WhatsApp status, Firecrawl inputs, dynamic `tool_spec`.
- Update `page.tsx` with queued auto-save logic (`saveQueue`, `adoptableAfterSave`, `savingRef`) preventing lost typing.
- Synchronize `src/app/app/workflows` with `src/app/(app)/workflows`.

### F. Database Migrations (`supabase/migrations/`)
- `20260903100000_whatsapp_workflow_reminders.sql`
- `20260903120000_workspace_provider_credentials.sql`
- `20260905130000_shopify_installs.sql`

### G. Test Suite (`tests/`)
- Port all workflow/automation tests from GrowthOS:
  - `firecrawl-workflow.test.ts`, `firecrawl-adapter.test.ts`, `firecrawl-missing-key.test.ts`, `firecrawl-resume.test.ts`
  - `whatsapp-workflow.test.ts`, `whatsapp-verification.test.ts`, `twilio-otp-routes.test.ts`, `twilio-otp-unconfigured.test.ts`
  - `dynamic-tools.test.ts`, `api-catalog-tools.test.ts`, `workflow-builder-dynamic.test.ts`, `workflow-trigger-layout.test.ts`
  - `shopify-oauth.test.ts`, `shopify-whatsapp-template.test.ts`
  - `slack-workflow.test.ts`, `slack-post-payload.test.ts`, `setup-notice.test.ts`
- Execute full test suite (`npm test`) and typecheck (`npm run typecheck`).

---

## 2. Verification Plan

1. **Typecheck**:
   - Run `npm run typecheck` in `automata` to verify clean TypeScript compilation.
2. **Automated Unit & Integration Tests**:
   - Run `npm test` in `automata` to verify all existing and newly ported tests pass.
3. **Build**:
   - Run `npm run build` in `automata` to verify production Next.js bundling.
4. **Devlog Archival**:
   - Archive implementation plan, task list, and walkthrough in `/Users/dubeysmac/Developer/doubtbuddy/devlog/`.
