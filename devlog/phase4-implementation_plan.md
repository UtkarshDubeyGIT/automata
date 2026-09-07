# Phase 4 Implementation Plan: Decouple GrowthOS Credentials, Add Automata Keys, and Complete Workflow Migration

## 1. Overview & Objectives
Automata is a standalone internal application designed to manage, execute, and monitor workflows and automations extracted from GrowthOS. In Phase 3, the foundational workflows, libraries, and integration routes were replicated.

This phase addresses the user's requirements:
1. **Exclude Google login credentials and GrowthOS-coupled environment keys**:
   - Eliminate Google OAuth login credentials copied from GrowthOS (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).
   - Remove the Google sign-in buttons from the login and signup authentication screens in Automata, focusing on email/password authentication.
   - Replace GrowthOS-coupled email sender domains (`zidaneai.com`) with Automata-specific domains (`automata.internal`).
   - Generate independent, dedicated encryption keys and cron secrets specific to Automata.
2. **Add Automata-specific environment keys**:
   - Define and export `AUTOMATA_SECRET_KEY`, `AUTOMATA_WEBHOOK_KEY`, `NEXT_PUBLIC_APP_NAME`, `NEXT_PUBLIC_SUPPORT_EMAIL`.
   - Update `src/lib/env.ts` and `.env.example`.
3. **Review and implement missing components from GrowthOS**:
   - Add `src/app/hooks/[token]/route.ts`: the dedicated inbound webhook route matching the canvas inspector's `/hooks/[workflowId].[secret]` URL pattern.
   - Synchronize `src/app/api/integrations/connect/route.ts` with Google Business Profile connect/disconnect and native server app row merging.
   - Update `src/app/api/integrations/callback/route.ts` to use `completeOAuthReturn`.
   - Update `src/app/api/integrations/catalog/route.ts` to support querying by specific slugs (`?slugs=...`), allowing connected tools outside the top 50 to render in the catalog.
   - Update `src/lib/social/oauth-return.ts` to use Automata channel and messaging brand labels (`automata:integration-return`, `automata:integration-complete`).
   - Synchronize `src/app/app/workflows/page.tsx` awaiting state (`operation?: string`).
   - Synchronize `src/app/(app)/integrations/page.tsx` UI to sort connected apps first and include Google Business Profile.
   - Port `src/lib/workflows/AGENTS.md` and CLI tools (`scripts/composio-tools.mjs`, `scripts/beat.mjs`).
4. **Verification**:
   - Unit and integration tests (`npm test`).
   - TypeScript verification (`npm run typecheck`).
   - Next.js production build (`npm run build`).

---

## 2. Proposed Modifications

### A. Environment & Auth Decoupling
- **`automata/.env.local`**:
  - Clear `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (exclude GrowthOS Google credentials).
  - Update `RESEND_FROM` and `EMAIL_FROM` to `Automata <noreply@automata.internal>`.
  - Provide a dedicated, unique `CREDENTIAL_ENCRYPTION_KEY` (AES-256-GCM 32-byte hex).
  - Provide a dedicated `CRON_SECRET`.
  - Add `AUTOMATA_SECRET_KEY=automata_sec_...` and `AUTOMATA_WEBHOOK_KEY=automata_wh_...`.
- **`automata/.env.example`**:
  - Document all Automata-specific keys and clear all GrowthOS-specific placeholders.
- **`automata/src/lib/env.ts`**:
  - Add accessors for `automataSecretKey`, `automataWebhookKey`, `appName`, `supportEmail`.
- **`automata/src/app/(auth)/login/page.tsx` & `signup/page.tsx`**:
  - Remove the "Continue with Google" OAuth form button and divider. Exclude Google login credentials as requested.
- **`automata/src/app/(auth)/actions.ts`**:
  - Update `signInWithGoogle` to fail gracefully with an explanatory notice if Google OAuth is disabled/unconfigured.

### B. Inbound Webhook Execution Route
- **`automata/src/app/hooks/[token]/route.ts`**:
  - Create route accepting `POST /hooks/[token]` (where token is `<workflowId>.<secret>`).
  - Calls `receiveWorkflowWebhook(req, workflowId, secret)`.
  - Configured with `maxDuration = 300` for long-running workflows.

### C. Integrations & Catalog Updates
- **`automata/src/app/api/integrations/connect/route.ts`**:
  - Add native handler for `slug === "googlebusinessprofile"` using `authorizeUrl`.
  - Add disconnect handler for `googlebusinessprofile` calling `disconnectBusinessProfile`.
  - Include cached server-owned apps in connection list.
- **`automata/src/app/api/integrations/callback/route.ts`**:
  - Replace inline HTML popup helper with `completeOAuthReturn(dest, slug, connected, popup)` from `@/lib/social/oauth-return`.
- **`automata/src/app/api/integrations/catalog/route.ts`**:
  - Add `?slugs=...` parameter parsing and `listToolkitsBySlug` invocation so connected apps below top popularity rank appear.
- **`automata/src/lib/social/oauth-return.ts`**:
  - Update BroadcastChannel to `automata:integration-return` (with backward compatibility for `zidaneai:integration-return`).
  - Update popup HTML title and button text to "Return to Automata".

### D. Workflow & Integrations UI
- **`automata/src/app/app/workflows/page.tsx` & `src/app/(app)/workflows/page.tsx`**:
  - Update `awaiting` type to include `operation?: string`.
- **`automata/src/app/(app)/integrations/page.tsx`**:
  - Sync with GrowthOS: prioritize connected integrations first in the grid (`cardRank`), display tools count, improve disconnect button.

### E. Architecture Docs & Operational Scripts
- **`automata/src/lib/workflows/AGENTS.md`**: Port complete workflow engine architectural reference.
- **`automata/scripts/composio-tools.mjs`**: Port CLI tool for catalog verification.
- **`automata/scripts/beat.mjs`**: Port local cron runner.
- **`automata/docs/`**: Port `SERVICES-AND-TRIGGERS.md` and `AUTOMATION-PRODUCTION-REQUIREMENTS.md`.

---

## 3. Verification Plan
1. **TypeScript Typecheck**:
   - Run `npm run typecheck` in `automata`. Must return exit code 0.
2. **Automated Test Suite**:
   - Run `npm test` in `automata`. All tests must pass (0 failures).
3. **Production Build**:
   - Run `npm run build` in `automata`. Must build all routes with exit code 0.
4. **Devlog Archival**:
   - Verify artifacts in `doubtbuddy/devlog/` and `automata/devlog/`.
