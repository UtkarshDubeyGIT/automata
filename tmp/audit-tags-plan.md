# Audit-tag implementation plan

Date: 2026-09-21
Status: implemented in the working tree; verification is complete and the release commit/push is next.
Scope: the five tasks in the supplied screenshot. The user explicitly selected **audit and build** for #3/#2 and **workspace brand voice** for #19.

## 1. Outcomes and verified starting point

| Task | Current evidence | Implementation outcome |
|---|---|---|
| #19 — Learn communication/writing style | Website analysis, editable brand voice, and Gmail/Slack read actions exist; accepted learned profiles do not. | Learn workspace brand voice from selected authors/accounts and website content, with review before activation. |
| #17 — Landing loading and jitter | Animation safeguards and logo fallbacks exist; current production loading and animation smoothness remain unverified. | Establish a production baseline, fix measured loading/rendering costs, and retain repeatable regression checks. |
| #14 — Workflow-builder debugging | Durable build jobs, retries, refunds, and scattered console errors exist. Workflow creation is separate from generation. | Searchable, safe diagnostics spanning build request, generation, preview acceptance, and workflow save. |
| #3 — GA4 or GBP rolling reports | GA4 reporting is implemented and tested; GBP currently provides reviews/replies, not performance reporting. | Scheduled 30-day reports from either source, delivered to Gmail or Slack. GA4 and GBP remain distinct sources. |
| #2 — Google/Meta Ads reports | Meta insights and a daily Gmail report template exist; Google Ads reporting is missing. | Complete Meta and Google Ads reporting with explicit account and Gmail/Slack destination selection. |

### Evidence and limitations

The pre-implementation review ran 52 targeted tests across app actions, autofill, registry, destinations, and workflow build jobs: **52 passed, 0 failed**. Those demonstrated existing code behavior, not authenticated provider access or actual delivery. No live messages were sent.

The original audit recorded 793 passed / 1 skipped, successful typecheck, a lint problem involving generated worktree output, and a development-browser sample with about 70 external logo requests and no observed layout shift. Those are historical observations, not newly reproduced results. Production traces and account-level access checks are still implementation gates.

Relevant existing seams:

- Brand learning: `src/lib/brand.ts`, website analysis/onboarding, Settings, and existing Gmail/Slack read capabilities.
- Workflows: registry/native tools, templates, destination handling, build jobs, creation request/store, and execution journals.
- Reporting: `src/lib/google/analytics.ts`, GBP client, Meta period helpers, and Composio proxy.
- Landing: `AuthOrbits`, `ToolLogo`, landing components and CSS.

Before writing application code, read applicable AGENTS.md files and relevant installed Next.js documentation under `node_modules/next/dist/docs/`.

## 2. Feature implementation

### #19 — Learn workspace brand voice

1. Add **Learn brand voice** in Settings. Owners/admins select the website, connected Gmail account/sender identities, and Slack authors/channels. Display exactly what will be sampled before collection.
2. Use workspace brand ownership, not private personal profiles. Verify selected accounts and authors against the workspace connection. Selecting a Slack channel does not select every participant; collect only explicitly selected authors. Do not assume a shared mailbox belongs to the requesting member.
3. Bound collection to the previous 90 days, 100 messages total, and 2,000 characters per sample. Strip signatures, quoted/forwarded replies, boilerplate, and unnecessary personal data. If eligible evidence is insufficient, report that instead of silently widening the scope.
4. Use a dedicated workspace-scoped profile table containing candidate/accepted versions, style guidance, confidence, source account/author identities, sample window, timestamps, and approving actor. Store summaries and provenance, not source message bodies. Owners/admins control mutations; workspace members may read accepted brand guidance.
5. Analyze sanitized samples transiently. Treat website/message content as untrusted evidence, never instructions. Do not log samples or full model responses.
6. Show a candidate before it affects generation. Support edit, accept, refresh, disable, and delete. Refresh creates a new candidate without replacing accepted guidance. Recheck authorization and profile version before storing a result so an in-flight refresh cannot resurrect a deleted profile.
7. Centralize prompt precedence: explicit brand instructions/tone first, accepted learned profile second, website-derived voice as fallback. Disabled/deleted profiles stop affecting newly generated content; invalidate relevant caches.
8. Reuse existing website analysis and connected-source access. Do not introduce a separate integration credential system.

Acceptance: a workspace owner/admin can select authors/sources, review and accept a profile, see it affect generation, and revoke it. Unselected authors and other workspaces cannot contribute samples. Explicit guidance remains authoritative.

### #17 — Landing loading and animation smoothness

1. Measure a production build, not development/HMR performance. Exercise cold load, scrolling, decorative motion, and representative hero interactions on desktop and mobile.
2. Record browser version and test hardware. Use desktop 1440×900 without throttling and mobile 390×844 at DPR 2 with 4× CPU slowdown, 1.6 Mbps download, 750 Kbps upload, and 150 ms latency. Keep these profiles fixed between baseline and comparison.
3. Capture LCP, FCP, CLS, transferred JS/image bytes, request counts, long tasks, and animation frame timing. Use three runs and median paint results. Record laboratory interaction latency separately from field INP; no layout shift alone does not prove smooth animation.
4. Initial mobile release budgets: LCP ≤2.5 seconds and CLS ≤0.1. Store traces/screenshots for failures. Record initial request/byte counts and reject regressions above 10% after the first measured optimization baseline.
5. Pause decorative canvas work when offscreen, preserve hidden-tab and reduced-motion behavior, and verify restart on re-entry.
6. Reduce unnecessary initial logo requests through a curated visible set and visibility-based loading below the fold. Preserve stable dimensions and lettermark fallbacks. Only change filters, masks, containment, or visual effects when traces demonstrate their cost.
7. Check screenshots at desktop/mobile widths and test failed asset responses. Require reduced initial asset cost and no new scrolling/interaction regressions against the baseline.

Acceptance: a repeatable production check passes the chosen budgets, decorative rendering stops offscreen, and failed logos do not destabilize the page. Keep authenticated/application routes outside this landing-focused optimization.

### #14 — Workflow-builder diagnostics through final save

1. Add a small server-only structured logger with allowlisted fields: level, event, timestamp, workspace/actor, correlation ID, build job, attempt, stage, duration, and safe error code. Centralize redaction and length bounds.
2. Bind correlation to the persisted build job so repeated enqueue requests and worker recovery reuse it. Extend build/status responses with correlation ID and safe error code.
3. Instrument enqueue, claim, model attempt, tool selection, validation/repair, refusal, completion/failure, recovery, and refund. Do not log prompts, message bodies, credentials, provider response bodies, or generated secrets.
4. Continue correlation through preview acceptance and the separate workflow creation route. Validate the build-job/workspace relationship and record creation key plus workflow ID. Distinguish `build_completed`, `preview_accepted`, `workflow_created`, and `workflow_creation_failed`.
5. Store operational events in a dedicated `workflow_build_events` table with workspace/job/time indexes, server-only inserts, owner/admin diagnostic reads, and 30-day retention enforced by the existing scheduled maintenance path. Reserve audit logs for durable user/security actions.
6. Deduplicate terminal events by job or creation identity and event type. Duplicate saves must report the original workflow identity rather than a second creation.
7. Logging failure must not break a valid build or save. Durable jobs/workflows remain authoritative; maintenance can reconcile missing terminal events. A queryable event view is sufficient for v1; a separate analytics dashboard is deferred.

Acceptance: support can follow a request through generation and final save, distinguish generated previews from saved workflows, and diagnose retries/refunds without seeing sensitive content.

## 3. Reporting implementation and provider gates

### Shared report behavior and interfaces

- Keep existing saved workflows and the daily Meta yesterday-report preset compatible. New rolling-report configurations default to **the previous 30 completed calendar days**, inclusive.
- Resolve the source-local reference date from the scheduled slot, or persisted manual-run timestamp. Freeze start/end dates and reporting timezone once per run before fetching; delayed execution and retries reuse them.
- Keep workspace scheduling timezone distinct from provider reporting timezone. Preserve provider date buckets without relabeling them. If timezone information is unavailable, surface that limitation instead of claiming workspace-local accuracy.
- Include provider, account/location, resolved range, source/scheduling timezone, currency/units, generated time, freshness/completeness, totals, and bounded daily rows in the report contract.
- Sum only additive metrics over disjoint rows. Compute CTR/CPC/CPM from aggregate numerators and denominators, with undefined ratios represented as unavailable. Do not sum daily unique users or reach into period totals. Preserve conversion definitions and attribution settings; missing/unsupported values are not zero.
- Start with account/location totals and daily metrics. Campaign/ad-group breakdowns, cross-provider blended totals, and monthly GBP keywords are deferred.
- Consume all pages/stream chunks before calling a report complete. Set per-source execution limits of 60 seconds, 100,000 rows, and 10 MB of decoded response data. Exceeding any limit or losing a page yields an actionable incomplete/failure state and withholds normal scheduled delivery.
- Store compact normalized results, not unbounded provider payloads, in workflow output. Pass only totals, up to 30 daily rows, and explicit freshness/availability notes to the summarizer.
- Add report source/account/period/destination configuration and source/destination readiness checks before activation. Recheck access at runtime because permissions can change.

### #3 — GA4 first, then GBP performance

**GA4:** reuse `GOOGLE_ANALYTICS_RUN_REPORT` and the existing token-safe Composio proxy. Its current default `30daysAgo` through `today` covers 31 inclusive dates; new report configurations must supply the corrected frozen range. Add complete pagination and separate aggregate queries where required for non-additive period metrics. Do not silently rewrite previously saved date presets.

Google documents inclusive date endpoints and property-timezone interpretation of relative dates. Completed days may still receive delayed processing or attribution updates, so expose freshness rather than promising final data. [DateRange](https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1alpha/DateRange), [GA4 reporting](https://developers.google.com/analytics/devguides/reporting/data/v1/basics), [Data freshness](https://support.google.com/analytics/answer/11198161?hl=en).

**GBP:** add a read-only `GOOGLEBUSINESS_GET_PERFORMANCE_REPORT` registry/native action using the existing GBP credential refresh/encryption path. Require selected location and allowlisted daily metrics; initially expose impressions, website clicks, calls, directions, and supported booking/order metrics. Label unavailable metrics without manufacturing zeros.

Verify approved project access, API quota, OAuth scope, and location permission before enabling the feature. Connecting OAuth alone is insufficient. Monthly keyword impressions are not an exact rolling-30-day daily report and stay outside v1. [GBP prerequisites](https://developers.google.com/my-business/content/prereqs), [Daily performance API](https://developers.google.com/my-business/reference/performance/rest/v1/locations/fetchMultiDailyMetricsTimeSeries), [Monthly keywords](https://developers.google.com/my-business/reference/performance/rest/v1/locations.searchkeywords.impressions.monthly/list).

Acceptance: a user can select GA4 or GBP, obtain correctly labeled complete 30-day metrics, and deliver the summary through Gmail/Slack. A blocked GBP project does not block GA4 reporting.

### #2 — Meta first, then Google Ads

**Meta:** extend the existing insights action and Gmail template with the shared reporting behavior. Verify connected ad-account access and currently granted read permissions. Preserve account timezone, currency, period reach, and attribution settings. Meta developer documentation was unavailable during parts of the research; do not mark current app-review eligibility as verified solely from the SDK. [Official Meta SDK](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adaccount.py).

**Google Ads:** add a read-only `GOOGLEADS_GET_REPORT` registry/native action through the existing Composio proxy. Validate customer/manager identifiers, use allowlisted GAQL shapes, normalize cost micros and metric types, and consume all Search pages or SearchStream chunks. Do not accept arbitrary user GAQL. [Search/SearchStream](https://developers.google.com/google-ads/api/rest/common/search).

Correct the previous developer-token prerequisite: Google states developer tokens were sunset on September 9, 2026; API access now follows the Google Cloud project owning the OAuth credentials. Verify the project behind the Composio connection, production access level, OAuth scope, and customer authorization. Do not build a new developer-token approval flow or automatic direct-token fallback. If the configured proxy cannot support the required access, mark Google Ads blocked with the concrete prerequisite while other providers remain usable. [Google Ads migration](https://developers.google.com/google-ads/api/docs/api-policy/developer-token), [Access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels).

Acceptance: Meta and Google Ads independently produce source-labeled, correctly aggregated reports and can target either supported destination. Mocked success is not evidence of production account readiness.

### Gmail/Slack delivery and recovery

1. Reuse existing destination handling. V1 supports Gmail and Slack only; other channels require a separate explicit adapter capability.
2. Resolve destination connection and recipient/channel before activation. Summaries must use only supplied numbers and must not invent changes without comparison-period data. Gmail gets a stable period-labeled subject; Slack gets a compact summary.
3. Add a durable delivery table with a unique identity over workspace, workflow run, step, and destination account/recipient/channel. Freeze the outgoing payload and report window before sending.
4. Atomically claim delivery and track pending, sending, sent, definitive failure, and unknown outcomes with safe provider receipt identifiers.
5. The existing workflow engine journals after a handler succeeds, so a crash after provider acceptance can leave a send unjournaled. A local idempotency key does not close this window. Use provider deduplication only where its contract is verified.
6. Reconcile ambiguous results through provider receipt/lookup where available. Otherwise park the delivery as unknown for owner/admin review; do not blindly resend after a timeout or expired claim. Explicit resend creates a new delivery attempt and warns of possible duplication.
7. Treat draft creation and sending as separate operations if retaining draft options. Neither a saved draft nor an unknown send counts as delivered.

Acceptance: concurrent workers cannot intentionally send the same delivery twice; confirmed sends are not retried; uncertain outcomes remain visible and are reconciled or reviewed. Do not claim unconditional exactly-once delivery. [Gmail sending](https://developers.google.com/workspace/gmail/api/guides/sending), [Slack sending](https://docs.slack.dev/reference/methods/chat.postMessage/).

## 4. Validation and delivery sequence

### Required tests

- **Voice:** owner/admin authorization, author filtering, same-workspace source selection, cross-workspace isolation, sample caps, no raw-body storage/logs, candidate acceptance, explicit-guidance precedence, disable/delete, and late refresh after deletion.
- **Landing:** production cold-load budgets, scrolling/frame traces, reduced motion, offscreen pause/resume, desktop/mobile screenshots, and failed-logo fallbacks.
- **Builder:** correlation across retries and final save, build success followed by save failure, lost creation response, duplicate-create recovery, refund recovery, redaction, and logger outage.
- **Reporting:** exactly 30 inclusive dates, DST/source-timezone boundaries, delayed slots and retries after midnight, weighted ratios, unique-user/reach totals, missing versus zero, attribution/currency, pagination beyond one page, interrupted streams, bounds, empty results, permission errors, and revoked connections.
- **Delivery:** Gmail/Slack graph configuration, concurrent workers, lost responses, crash after provider acceptance before persistence, expired claims, successful reconciliation, and unresolved unknown outcomes.

Run targeted tests during each change, then the full applicable suite, typecheck, and production build before release. Record lint blockers separately rather than reporting a clean lint result if generated-worktree noise remains.

### Delivery order

1. **Access audit:** record per-provider verdicts as supported, blocked by prerequisite, or unverified. Verify actual configured account/project access through safe read-only checks. Do not let one blocked provider block the others.
2. **Independent foundations:** add #14 diagnostics through workflow creation; establish #17 production measurement. Add only the reporting/date/delivery contracts needed by the first concrete path.
3. **Existing-source reporting:** complete GA4 and Meta through Gmail, then Slack. Prove correct windows, aggregates, completeness, and post-send crash handling before expanding sources.
4. **Missing sources:** add GBP and Google Ads independently against the proven report/delivery contract.
5. **Brand voice:** deliver #19 independently of reporting provider approvals.
6. **Measured landing fixes:** ship the optimizations validated against #17's baseline.

Use additive migrations for voice profiles, operational events, and delivery records. Keep new features inactive until their configuration/access checks pass; do not backfill or activate existing schedules automatically. For release, perform controlled account-level reporting and send tests only to explicitly designated recipients/channels. Record source access failures, incomplete reports, unknown deliveries, builder failure codes, and performance regressions as separate operational signals.

## 5. Locked decisions and implementation boundaries

- All five screenshot tasks are in scope; #2/#3 include audit **and** implementation per user clarification.
- Voice is workspace brand voice, with owner/admin approval; private member voice profiles are out of scope.
- Gmail and Slack are the first-release destinations. “Any channel” is not a universal-delivery promise.
- New rolling reports default to 30 completed days; existing saved configurations remain compatible.
- Reporting uses existing workflow execution and credential boundaries; no parallel workflow engine or automatic second credential system.
- Separate operational diagnostics with 30-day retention; no new dashboard required.
- The research/architecture review informed source ownership, aggregation/date contracts, creation correlation, and ambiguous-send handling.
- Remaining provider access checks are deployment prerequisites, not permission to claim a verified integration. No authenticated provider checks or live deliveries were performed; the local production landing check is recorded below.

## 6. Implementation handoff

The plan is implemented as additive, inactive-by-default capabilities:

- Workspace brand voice now has an owner/admin review flow, connected-account selection, bounded 90-day sample sanitization, website-analysis provenance, accept/disable/delete controls, and explicit-guidance precedence.
- Landing decoration pauses offscreen, respects reduced motion/hidden tabs, defers the logo wall until near visibility, uses a bounded curated set, and keeps fixed-size fallbacks. `npm run check:landing` now runs three fixed-profile iterations, reports browser/hardware, median LCP/FCP/CLS/resource/JS/image bytes/long-task/frame data, scroll-loads the wall, and writes a screenshot/trace when a budget fails.
- Workflow build events correlate enqueue through tool selection, model attempts, validation/repair/refusal, recovery/refund, preview acceptance, and final save; they redact content, retain 30 days, and are best-effort. Report deliveries claim durable identities using the connected account when available, store compact receipts, distinguish sent/definitive failure/unknown, and expire abandoned claims to unknown.
- GA4, Meta Ads, Google Ads, and Google Business Profile report actions use the persisted run reference time, frozen inclusive date windows, pagination/size/time bounds, source/scheduling timezone labels, generated time, units/currency, coverage and availability notes, source-labeled normalized totals, and the new Gmail/Slack templates. Campaign/ad-group breakdowns remain deferred. Provider access remains runtime-gated and unverified here.

Verification completed before handoff:

- `npm test`: 815 passed, 1 pre-existing skipped.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Targeted ESLint over all changed source/tests/scripts: passed. Repository-wide `npm run lint` remains blocked by generated `.next` and `.claude/worktrees` output already present in the workspace.
- Local production landing check (Chromium 149.0.7827.55 on Apple M2, three-run median) passed the budgets: desktop LCP 88 ms, FCP 88 ms, CLS 0, 60 requests / 294,961 transferred bytes, 163,682 JS bytes, and the wall loaded after scroll; mobile LCP 896 ms, FCP 832 ms, CLS 0.019, 25 requests / 293,264 transferred bytes, 163,682 JS bytes, frame p95 17.6 ms, and the wall loaded after scroll. No authenticated provider calls or live deliveries were performed.

Known v1 boundary: the Settings voice flow accepts admin-selected, manually pasted sample bodies with verified connected-account IDs; it does not yet fetch Gmail/Slack message bodies or verify sender identity against provider records. Keep the feature owner/admin-only and treat provider-backed sample retrieval as a follow-up before calling the acceptance path fully verified.
