# Services and real-time triggers — what has actually been tested

Written 2026-08-28. Every line below was produced by running something, not by
reading code. Two probes refresh it:

```
node scripts/composio-tools.mjs --watch-probe          # triggers
node --experimental-strip-types \
  --import ./scripts/test-register.mjs \
  scripts/service-probe.ts --workspace <id> [--writes] # tools
```

## Why this file exists

The product's real-time claims were, until this run, claims about a code path
nobody had executed. `GET /trigger_instances/active` was empty: no watch had
ever been created against Composio, so no pushed event had ever arrived, and
the hourly sweep's fallback was the only part that had ever run. Nothing was
known to be broken — nothing was known at all.

Reading the catalog cannot answer this. A trigger type existing and that type
accepting *your* account with *your* config are different questions, and the
second one is what a user is actually promised.

## The delivery endpoint

| | |
|---|---|
| URL | `https://automata.doubtbuddy.com/api/composio/triggers` |
| Events | `composio.trigger.message`, `composio.trigger.disabled`, `composio.connected_account.expired` |
| Signing secret | matches `COMPOSIO_WEBHOOK_SECRET` in `.env.local` — verified by comparison, not assumed |
| Reachability | live; returns 401 to an unsigned POST, i.e. the route and its HMAC check are deployed and working |

Registered **once per Composio project**, not per instance — which is why the
route resolves the workflow from `trigger_state->realtime->>instanceId` in the
payload rather than from the URL.

## Results — 2026-08-28

Probe run against production with a real connected account per toolkit. Each
watch was created, confirmed present in `trigger_instances/active`, then
disabled.

| Trigger | Result | What Composio called it | Notes |
|---|---|---|---|
| `NEW_GITHUB_ISSUE` | **subscribed** | `webhook` — genuine push | `GITHUB_ISSUE_ADDED_EVENT`, on a repo the account has admin on |
| `NEW_LINEAR_ISSUE` | **subscribed** | `webhook` — genuine push | `LINEAR_ISSUE_CREATED_TRIGGER`, needs `team_id` |
| `NEW_GMAIL_EMAIL` | **subscribed** | `poll` | Composio polls Gmail on its own ~2min interval. Beats our hourly sweep; is **not** a push |
| `NEW_CALENDAR_EVENT` | **subscribed** | `poll` | Same — Composio-side polling |
| `NEW_SLACK_MESSAGE` | **not tested** | would be `webhook` | No Slack account connected. Slack uses Composio-managed OAuth, so it needs no developer app — only a Connect click |
| `NEW_SHOPIFY_ORDER` | **not tested** | cannot push | No Shopify account connected, **and** Shopify publishes zero trigger types, so this can only ever poll |
| `NEW_GOOGLE_REVIEW` | **n/a** | cannot push | Google publishes no webhook for reviews at all, so this polls. Runs against the real Business Profile API when `GOOGLE_CLIENT_ID` is set (Composio has no toolkit — the client is ours, `lib/google/business-profile.ts`), simulated when it is not |

**4 of 7 subscribed, 0 failed.** Two genuine webhook pushes proven end to end
against live accounts, for the first time.

### What is still unproven

- **No real event has been delivered.** Subscribing is proven; Composio
  actually pushing a live event into the route is not. The route's own handling
  of a delivery is covered by `tests/composio-webhook.test.ts`, which signs
  payloads with the real HMAC scheme, but the wire between Composio and us has
  only been proven in the outbound direction.
- **Slack and Shopify** are blocked on connections, not on code. Shopify is
  additionally blocked by the separate "Composio configuration for meta and
  shopify" work — Composio hosts no shared OAuth app for it.

## Two facts worth not re-learning

**"Real time" is not one thing.** Composio types each trigger `poll` or
`webhook`, and only `webhook` is a genuine push. Gmail and Google Calendar are
Composio-side polls on their own interval. Both beat our hourly sweep and both
subscribe identically, but they are different promises — which is why
`enable()` records which one it got as `trigger_state.realtime.channel`, and
why the UI says "Runs in real time" only for a push.

**A subscription failure is usually about permissions, not the trigger.**
GitHub refuses to create a webhook on a repository the connected account lacks
admin on, and reports it as `Repository <owner>/<repo> not found` — which reads
like a wrong slug and is not. The probe prints the connected-account id in that
message for exactly this reason.

## Re-running

```
PROBE_GITHUB_OWNER=<owner> PROBE_GITHUB_REPO=<repo> \
PROBE_LINEAR_TEAM_ID=<uuid> \
  node scripts/composio-tools.mjs --watch-probe
```

Targets come from the shell, not `.env.local` — they are per-run answers about
which repo or channel to watch, not secrets. Anything without a value is
reported `needs-config` rather than guessed at.

The probe is safe to run against production: the instances it creates belong to
no workflow, and the inbound route resolves deliveries by instance id, so an
event arriving for one of them matches nothing and fires nobody's automation.
Teardown runs in a `finally`.


---

# Services (registry tools)

## Why this half needed its own probe

`--verify` checks that every tool slug and `required` list matches the live
catalog. That is a claim about Composio's data, not about ours. The code most
likely to be wrong sits between the two — argument building, the Meta
ad-account autofill, the placeholder refusal, simulation taint, and the
read-vs-write retry policy — so `service-probe.ts` executes each tool through
`HANDLERS.app_action`, the same path a real run takes, rather than calling
Composio directly.

**Connections are per workspace, not global.** A toolkit connected somewhere in
the project says nothing about whether the workspace under test can use it, and
the handler resolves accounts by workspace id. The probe reports `blocked`
per workspace for exactly this reason.

## Results — 2026-08-28, workspace `07ef5472` (PriyaA Label)

The richest real workspace: github, gmail, googlesheets, linkedin, notion.
Run with `--writes`. **10 ok, 0 failed.**

| Tool | Kind | Result |
|---|---|---|
| `NOTION_FETCH_BLOCK_CONTENTS` | read | ok — 15 records |
| `GOOGLESHEETS_BATCH_GET` | read | ok |
| `GITHUB_LIST_REPOSITORY_ISSUES` | read | ok |
| `LINKEDIN_GET_MY_INFO` | read | ok |
| `GOOGLEBUSINESS_GET_REVIEWS` | read | real via `lib/workflows/native-tools.ts`; simulated only when unconfigured |
| `GOOGLEBUSINESS_REPLY_TO_REVIEW` | write | real via `lib/workflows/native-tools.ts`; simulated only when unconfigured |
| `GMAIL_SEND_EMAIL` | write | ok — mail sent, cannot be unsent |
| `NOTION_CREATE_NOTION_PAGE` | write | ok — page created, then archived |
| `GOOGLESHEETS_BATCH_UPDATE` | write | ok — row written to a throwaway sheet |
| `GITHUB_CREATE_AN_ISSUE` | write | ok — issue opened, then closed |
| `LINKEDIN_GET_COMPANY_INFO` | read | needs-config — set `PROBE_LINKEDIN_ORG` |
| `GOOGLECALENDAR_FIND_EVENT` / `_CREATE_EVENT` | both | blocked — Calendar is connected under other identities, not this workspace |
| `SLACK_FETCH_CONVERSATION_HISTORY` | read | blocked — no Slack connection |
| `WHATSAPP_*` (3) | both | blocked — no WhatsApp connection |
| `SHOPIFY_GET_PRODUCTS` / `_ORDER_LIST` | read | blocked — no Shopify connection |
| `METAADS_GET_INSIGHTS` | read | blocked — no Meta Ads connection |

### What blocks the remaining ten

- **Slack (1 tool) and WhatsApp (3)** — both have Composio-managed OAuth, so
  they need no developer app, only a Connect click on `/integrations`. Connect
  through the app rather than Composio directly, so the local `integrations`
  row is written too; the handler's pre-check reads that row, not Composio.
- **Google Calendar (2)** — connected under `poc_user` and another non-workspace
  identity, so no real workspace can use it. Needs a connect under a workspace.
- **Shopify (2) and Meta Ads (1)** — blocked by the separate "Composio
  configuration for meta and shopify" work: Composio hosts no shared OAuth app
  for either, so both need our own developer app registered first.
- **`LINKEDIN_GET_COMPANY_INFO` (1)** — needs an organisation id; there is no
  generic answer, so the probe reports it rather than guessing.

## Cleanup from the last run

Handled automatically: the GitHub issue was closed, the Notion page archived.
Left behind on purpose, because they cannot be undone from here:

- One email to `community@doubtbuddy.in`, subject `growthos service probe …`.
- A throwaway spreadsheet, *growthos service probe (safe to delete)*
  (`1-0izI6ZJf9rb0uON97tVDCC9E7T4csdJfY243NAeX8U`), created so the write test
  never touched a real business sheet.

## Offline coverage

`tests/app-action.test.ts` covers what a live probe cannot provoke without
breaking a provider on purpose: that a write is never retried (a timed-out
write may already have landed), that a disconnected account fails before the
provider is called, that an unresolved `{{…}}` is caught even in an argument
nothing requires, and that a toolkit-less app runs simulated and tainted even
against a live provider. Autofill, the placeholder guard and taint have their
own files and are not repeated there.
