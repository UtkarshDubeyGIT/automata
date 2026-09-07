# Workflows

The "Automations" system: a graph builder (chat + visual editor + templates)
and a durable execution engine, behind `/workflows` pages, `/api/workflows/*`
routes, and the cron beat (`src/app/api/cron/route.ts`). `src/lib/goals` is
the other caller — `goals/execute.ts`'s `buildAutomation` calls `buildWorkflow`
+ `insertWorkflow` directly, so a workflow the goal layer plans on its own and
one a user built by hand are the same row, opened by the same editor.

## relay_poc is the prototype, not live code

`relay_poc/` (repo root) is this system's design ancestor, not something
consulted at runtime: its README calls itself a proof of concept, it runs
standalone via `python demo.py` against SQLite, and nothing in `src/` imports
or shells out to it. Several header comments here literally say "TypeScript
port of relay_poc/X.py" — the concepts map closely (`engine.py`'s
`Engine._drive`/`Suspend` → `engine.ts`'s `drive`/`Suspend`; `scheduler.py`'s
`is_due` → `blocks.ts`'s `dueSlot`) — useful for *why* a shape looks the way
it does, but don't treat it as current: it's missing multi-tenancy
(`server.py` hardcodes one `POC_USER_ID`), Supabase persistence, and a
credits ledger, though `integrations.py` does make real Composio REST calls
when `COMPOSIO_API_KEY` is set.

## The graph model

A workflow is `{ start, steps: Record<id, StepDef> }` (`types.ts`). Routing
lives flat on each step (`next`, `on_approve`/`on_reject`, `branch_on` +
`cases` + `default`, `on_fail`). `graph.ts` is the one place that knows what
an edge is (`outEdges`, `edgeSlots`, `findCycle`, `ancestors`,
`refsIn`/`refPathsIn` for `{{steps.<id>.<path>}}` templates) — validation,
display derivation, and editor mutations all import these instead of
re-walking the graph. `blocks.ts` (~1300 lines, the largest file) is the
single node catalog (`NODE_TYPES`) that the AI prompt, the editor's palette/
inspector, and validation all read — why an AI-built graph is always one the
visual editor can open — and, less obviously, also owns all schedule-trigger
timezone math (`dueSlot`, `zonedTimeToUtc`, `safeTimeZone`). `registry.ts` is
the separate catalog of Composio tools (`TOOLS`) and app-event triggers
(`TRIGGERS`) an `app_action`/`app_event_trigger` step may reference; social
posting is deliberately not here — it's the dedicated `social_post` step via
`socialProvider.post()`.

## builder.ts — sharp edge: prompt examples get echoed back as real values

`buildWorkflow`/`editWorkflow` prompt the model with the full node/tool/
trigger catalog (including each tool's `argHint`, e.g. `'{"owner": "",
"repo": "", "state": "open"}'`), parse the JSON, repair near-misses
(`repair.ts`), validate, and re-ask on failure (`MAX_REPAIRS = 2`).

This already broke exactly this way once (commit `b79fe6d`): `argHint` used
to read `'{"owner": "<org>", "repo": "<repo>"}'`, a request never named a
repo, and the model copied `<repo>` through as the answer — which validated,
saved, switched on, and polled GitHub hourly for a repo literally called
`<repo>`. The fix is three layers because graphs already on disk can't be
reached by a prompt change: prompt rule 3e now says to write an empty string
instead of a stand-in; `stripPlaceholders()` (`repair.ts`) blanks anything
matching `isPlaceholder()` (`registry.ts`, model output only — never a
human's own input); and `steps.ts`'s `appAction` handler refuses at run time
on the **raw** argument, skipped once the value is a resolved `{{...}}`
(that's data from an earlier step, not a config mistake). Any new tool/
trigger with an example-shaped `argHint` can reintroduce this — check
`isPlaceholder()`'s patterns still cover it (deliberately narrow: no
`todo`/`tbd`, since those are real repo/channel names too). Separately, the
system prompt's rules 13/13b still hand the model two fully-worked few-shot
examples with literal node ids (`new_google_review`, `draft_positive`)
inline — same risk shape, just not the one this commit fixed; watch for
output suspiciously matching them.

## Validation (validate.ts)

`validateGraph` is the one gate every graph passes through (AI, hand-edit,
template) — pure, so the editor lints on every keystroke and the save route
re-checks server-side. Beyond structural checks, `validateRefFields` catches
the classic "built fine, died on first run" bug: a `{{steps.X.Y}}` must name
a field X actually produces (text-mode `ai_step` → only `.text`; json-mode →
only `.result...`). `validateApprovalEdges` catches the human-in-the-loop
equivalent: `route()` takes the approval branch on any step carrying a wired
`on_approve`/`on_reject`, but only `human_approval` emits a `decision`, so
those keys anywhere else read `undefined` and take `on_reject` on every run —
silently, since nothing suspends, no run reaches `waiting`, and neither the
sidebar badge nor the review banner ever fires. The approval the author asked
for just never happens. The editor can't build it (`insertOnEdge` writes those
keys only where the spec's `routing` declares them), so the source is a model
ignoring prompt rule 7 — which is why the guard is here and not there. Only a
*wired* edge is rejected: a leftover `on_approve: null` is inert for routing,
and failing on it would strand a saved graph, since the canvas can null an
edge but never delete the key. `missingSetup`/`setupGaps` is a separate,
non-fatal notion — a blank-but-fillable field is allowed to save, it just
blocks switching the automation on ("Needs setup").

## What a schedule_trigger may say (blocks.ts)

`scheduleSpec()` is the ONE reading of a schedule step, and everything —
`scheduleLabel`, `scheduleSlot`, `nextSlots`, the validator, the AI prompt and
the editor's control — goes through it. That is what makes "a routine you can
tap out is a routine the chat can ask for" true rather than aspirational; add a
shape in one place and the others keep agreeing.

Five keys, and the set is a strict SUPERSET of the original three cadences, so
rows written before intervals existed read back as exactly what they always
meant. There is no migration and nothing rewrites live graphs:

| key | applies to | meaning |
| --- | --- | --- |
| `cadence` | always | `"hourly" \| "daily" \| "weekly"` |
| `hour` | daily, weekly | 0-23, in the workspace zone |
| `every` | daily, hourly | units between runs; max 30 days / 23 hours |
| `weekdays` | weekly | `number[]`, 0=Sunday…6=Saturday, never empty |
| `weekday` | weekly | the original single day; read only when `weekdays` is absent |
| `start` | daily, `every` > 1 | `YYYY-MM-DD` the interval counts from |

Two rules the whole thing rests on:

- **`every` needs a fixed anchor.** Counting an interval from "today" makes
  every day divisible by itself, so it fires daily — the exact over-firing this
  replaced. Absent `start` falls back to the epoch: an arbitrary phase, but a
  stable one. `repairSchedules` fills in today's date for compiled graphs,
  because the model is never told what today is.
- **`weekdays` on a non-weekly cadence is rejected, not ignored.** Ignoring it
  silently runs every single day. `repairSchedules` moves the cadence to match
  when the model clearly meant days; anything else fails validation loudly.

"Every day" has ONE representation — `daily` + `every: 1`, not seven ticked
days — so two graphs that mean the same thing look the same. The editor still
shows all seven circles lit for it, because that is what it means.

## Execution/locking machinery: runtime.ts (claim.ts, drain.ts, sweep.ts, engine.ts)

- **`runtime.ts`** — the deep workflow execution runtime consolidating `claimRun`,
  `drainRuns`, `resumeRenders`, `reclaimStuckRuns`, and idempotency key builders
  (`manualKey`, `scheduleKey`, `appEventKey`, `webhookKey`). `claim.ts` and `drain.ts`
  re-export from here for backwards compatibility.
- **`engine.ts`** — the pure interpreter. `drive()` replays journaled steps
  by re-deriving routing (never re-running side effects), then executes
  forward: handler → journal clamped output → merge into context → route,
  persisting after every step. `STEP_BUDGET = 50` is a runtime backstop
  against a cycle even though `findCycle` now rejects one at build time —
  belt-and-suspenders for a graph saved before that check existed.
  `clampOutput` bounds jsonb size by shortening leaves at every depth rather
  than collapsing to scalars — the old version could blow away an oversized
  `ai_step`'s whole `.result` and silently break downstream branches. A step
  throwing `Suspend` pauses the run durably for `human_approval`; resuming
  just calls `drive()` again.
- **`claim.ts`** — "the one place a run starts." `claimRun()` collapses what
  used to be three separate charge-then-start paths into one exactly-once
  sequence: INSERT a row with an idempotency key (unique violation = someone
  already claimed it, charge nothing) → only the winner charges credits →
  drive in-request (`mode: "execute"`, the Test button) or leave `queued`
  for the beat (`mode: "enqueue"`). Keys are identity-based, not time-based —
  `scheduleKey` uses the due *slot*, never `now`, so a late beat still fires
  exactly once. `claimForDriving` is a compare-and-swap so a cron beat and a
  person clicking Approve can never both drive one run; `STALE_CLAIM_MS`
  (5 min) is how long a silent `running` row may go before another driver
  may steal it. `refundIfClean` only refunds a failed run if its journal
  shows no real (non-simulated, non-read) action actually landed.
- **`drain.ts`** — what the beat does with rows already claimed/paid for.
  `drainRuns` drives `queued` + stale-`running` rows, oldest first, in
  batches of `limit` (25 by default) and stops early once a wall-clock
  `deadline` passes mid-batch; `MAX_DRIVE_ATTEMPTS = 3` stops a run that
  hangs on the same step forever. `reclaimStuckRuns` gives up on rows
  nothing will ever finish (queued >1h, running silent >1h, waiting >30
  days) and refunds them.
- **`sweep.ts`** — decides what's due for `schedule_trigger`/
  `app_event_trigger` only (`webhook_trigger` is pushed directly to
  `/api/workflows/[id]/webhook`, never swept). Every fire goes through
  `claimRun(mode: "enqueue")` — the sweep never drives, so it can't be held
  behind nginx's proxy timeout. Fragile invariant: an unset `watch_*` or a
  *failed* poll must never baseline the cursor, because `untilCursor` treats
  a cursor it can't find as "page moved past it" and returns everything —
  previously firing one run per pre-existing record the moment setup got
  fixed. `TriggerState` lives in its own `workflows.trigger_state` column
  (not `config`) specifically so a save mid-sweep can't revert the graph the
  user is editing.

- **`run-request.ts`** — the client half of the Run button, and the only place
  a manual run's idempotency key is minted. The route drives the whole workflow
  in-request while nginx caps a *public* request at 60s (deploy/AGENTS.md), so a
  healthy multi-step run routinely answers the browser with a proxy 504 and
  finishes anyway: an unreadable body or an aborted fetch is `unknown`, never
  `failed`. The key is kept for as long as the outcome is unknown, so the press
  that follows re-sends it and `claimRun` returns the run already in flight —
  minting a fresh uuid per click (what both call sites used to do) made the
  exactly-once promise true of retried fetches and nothing else.

`build-jobs.ts` applies the same durable shape to AI-authored graphs: the
authenticated enqueue RPC inserts the 24-hour job and credit debit in one
transaction, the route returns `202`, and `after()` plus cron race for two
global worker slots. A row lease prevents two workers building one prompt;
failed rows retain enough state for an idempotent refund retry without calling
the model again. `build-request.ts` is the client seam: an unreadable enqueue
response keeps its request key, while status-read failures keep polling the
known job rather than reporting that paid work failed.

`create-request.ts` owns the separate identity of the final workflow-row
creation. Concurrent calls for one preview/template share a promise, and an
unanswered request keeps its nonce for the retry. The database's unique
`(workspace_id, creation_key)` index is the final arbiter: client locks improve
the interaction, but they are not the exactly-once guarantee.

## interpolate.ts — the pure half of the step library

`interpolate`, `resolveDeep`, `assertResolved`, `normalizeValue`, `extractJson`
and `flattenRecordsToText` were the tail of `steps.ts`. That is a dependency
problem, not a length one: `steps.ts` statically imports the OpenAI client, the
Composio client, the image generator, the credit ledger and the Supabase admin
client — its handlers genuinely need them — so anything that wanted ONE of
those six pure functions inherited all of it. `preview.ts` wanted exactly one.

`steps.ts` re-exports all six, so the engine, the tests and the relay ports find
them where they always were; this is a move, not a rename. The reason to keep
them apart is the trap under `apps.ts` above, and it is now checked rather than
remembered — `tests/pure-modules.test.ts` fails if `preview.ts`, `validate.ts`,
`limitations.ts`, `apps.ts`, `layout.ts` or `interpolate.ts` reaches a provider,
and separately if any of the seven `"use client"` workflow components does.

`resolveDeep` takes a structural `ResolveScope` (`{ data, reads? }`) rather than
`StepCtx`, which is what lets the pure module stay ignorant of the handler-side
type without any call site changing.

`realtime.ts` sits beside these: it best-effort upgrades an
`app_event_trigger` to a pushed Composio trigger when switched on, but is
designed to **never** fail the toggle — anything it can't arrange just
records a `reason` and leaves it polling. That `reason` is now read:
`display.ts` puts it on the view model as `trigger.deliveryReason` and
`limitations.ts` shows it. For years it was written and read by nothing, so
an automation that asked for real time and settled for hourly polling looked
exactly like one that never wanted real time.

Two things about `realtime.ts`'s resolution step are load-bearing and were
both wrong against the live catalog. `RealtimeSpec.slugs` is a preference
list resolved against Composio's real trigger types, and when no slug matches
exactly `resolveTriggerType` falls back to a loose word match — which must
now be **unique** or it returns null. It wasn't, and Google Calendar paid for
it: none of the three guessed slugs existed, the words CALENDAR + EVENT match
six of that toolkit's seven trigger types, and the first happened to be
`EVENT_CANCELED_DELETED` — which accepts the same `calendarId`, so "when an
event is added" subscribed cleanly to cancellations. Separately, a push
payload is the provider's own webhook body and is **not** shaped like the
poll listing, so `mapEvent` must not casually delegate to `mapRecord`: GitHub
spells the same fields `description`/`createdBy` where the REST API says
`body`/`user.login`, and a Gmail push carries the message flat at the top
level *and* a `payload` key holding the MIME tree, so unwrapping into it
discarded every field. Both failures are invisible from the editor — the Test
button uses `sample` and the sweep uses `mapRecord`, so only genuine pushed
events are affected. `tests/realtime-triggers.test.ts` pins the payload
shapes; re-derive its fixtures from the live catalog rather than editing them
to match the code, and run `node scripts/composio-tools.mjs --verify` after
touching the registry — it diffs every slug, `required` list and
`realtime.needs` against the catalog the app actually calls.

Two facts about that catalog are worth holding on to, because both are
invisible from the code:

- **Reads and executes run on different toolkit versions.** Every `GET` in
  `composio.ts` omits `toolkit_versions`, which Composio's migration guide says
  selects the frozen `00000000_00` pin — but `execute()` explicitly sends
  `version: "latest"`, and that one is deliberate: the comment there records
  that the pinned snapshot lags provider API versioning and LinkedIn's yearly
  sunset made it fail with `NONEXISTENT_VERSION`. So `steps.ts` invokes the
  latest implementation while the catalog endpoints describe the pinned one,
  and they do diverge (`GMAIL_SEND_EMAIL` requires nothing on latest,
  `recipient_email` + `body` on the pin). Two consequences: a missing
  `required` entry fails against **latest**, so that is what
  `scripts/composio-tools.mjs --verify` compares; and `mapRecord`, which hand-
  parses response shapes, is parsing **latest** output that can change without
  us choosing to move.
- **"Real time" is not always a webhook.** Composio types each trigger `poll`
  or `webhook`. Only GitHub, Slack and Linear are genuine pushes; Gmail's and
  Google Calendar's are Composio-side polls on their own `interval` (default 2
  minutes). Both are subscribed identically and both beat the hourly sweep, but
  they are different promises, so `enable()` records which one it got as
  `trigger_state.realtime.channel` and the UI reads it — "Runs in real time"
  only for a push. Rows written before that field existed have no `channel` and
  deliberately keep the old wording rather than being demoted on no evidence.
- **A watch can stop existing without us asking.** Composio disables a trigger
  instance on its own when auth expires or a webhook subscription cannot be
  refreshed, and it announces that as a `composio.trigger.disabled` delivery.
  Acting on it is not optional: the sweep refuses to poll anything it believes
  is being pushed to, so an instance that dies unrecorded leaves the workflow
  with no watcher at all — and because that skip branch clears `lastError` every
  pass, the header keeps showing a fresh "last checked" for an automation that
  has silently stopped. `demoteToPolling` (realtime.ts) flips it back to
  `mode: "poll"` with a reason and **drops `instanceId`**, which is the half of
  the sweep's condition that actually restarts polling. It leaves `cursor`
  alone on purpose — it was set by a real poll and still names a real record,
  so the next sweep resumes from it instead of baselining or replaying a page.
  Composio does not send this when we disable a trigger ourselves, so pausing
  an automation cannot trigger it.
- **`enable()` walks the candidate list, it does not take the first match.**
  Several toolkits publish more than one type for one event, differing only in
  what they insist on knowing, so a type is only usable once the user's
  `watch_*` values have been fitted against its config schema — which is after
  resolution. Linear forced this: `LINEAR_ISSUE_CREATED_TRIGGER` requires
  `team_id`, so a blank Team meant no real time at all, while
  `LINEAR_PUBLIC_TEAM_ISSUE_CREATED` pushes the same event with `team_id`
  optional. Preference order still wins among satisfiable candidates, so
  filling Team in keeps the type that also covers private teams. The corollary
  for `RealtimeSpec.needs`: it means "real time is UNREACHABLE without this",
  not "the preferred type wants this" — Linear correctly declares none.

## preview.ts — what a person is actually approving

A `human_approval` step suspends the run and `engine.ts` writes
`log.pending = { token, stepId, prompt }`. For a long time that prompt was the
entire answer to "what am I approving?", so every approval in the product read
"Approve this before it goes out?" over two buttons — while the post was
already written into the run context, the picture already archived, and the
account already named on the next step. Consent to something invisible is not
consent.

`buildApprovalPreview(graph, stepId, log)` is that answer: it walks the
`on_approve` edge forward, resolves each following step's templated config
against the run's OWN context with the same `interpolate` the handler will
use, and returns the content — post text, image URL, destination fields
(Slack channel, subreddit, recipient, subject) — plus plain-English
approve/reject lines. Pure and I/O-free. Three rules it exists to keep:

- **It stops at a `branch`/`filter`** and sets `conditional`, because which
  way a run goes is decided by data it has not produced yet. It falls back to
  `drafts` (the newest `ai_step`/`generate_image` outputs in the journal), so
  the shipped "classify → approve → post to one of three places" template
  still shows the words being judged.
- **An unresolved `{{steps.x.y}}` is a sentence, not a string.** A step that
  runs AFTER the decision has produced nothing, so the reference is stripped
  and `unresolved` carries the fact. A value that was *only* a reference
  yields no `body` at all — "…" rendered as the post looks like the
  automation is about to publish one character.
- **The snapshot is taken at suspend time**, in the engine, wrapped so a
  preview it cannot build never fails a run. A workflow edited while a run
  waits must not change what the card claims was up for approval — the same
  reason the run replays against its claimed graph. `pendingPreview(log,
  graph)` is the read path both run endpoints use: snapshot first, derived
  from the current graph second, so runs that were already `waiting` when this
  shipped are not stuck showing the bare prompt forever.

The UI half is `src/app/(app)/workflows/approval-preview.tsx`, shared by the
Automations "Needs your attention" card and a workflow's own Runs tab — the
two places one run can be approved, which must not describe it differently.
It imports the `ApprovalPreview` **type** from `types.ts`, never this module —
still the rule, though the reason has been removed rather than only avoided:
`interpolate` now lives in `interpolate.ts` (below) and `platformMeta` in
`social/platforms.ts`, so `preview.ts` no longer reaches a provider client at
all. `tests/pure-modules.test.ts` asserts that by walking the import graph.

## generate_video, and parking a run on a machine

`steps.ts` has one handler that cannot return the way the others do. A video
takes five to fifteen minutes, is rendered by its own state machine in another
process (`lib/video/advance.ts`), and a workflow step is expected to finish.
So `generate_video` does not wait — it queues the row, throws `Await`, and is
re-driven later. The second execution is the one that returns a URL.

Three things hold that together, and all three are load-bearing:

- **`Await` is not `Suspend`.** They pause a run identically, but `Suspend`
  writes `log.pending` (a person must decide) and `Await` writes
  `log.awaiting` (a machine must finish). Everything downstream reads the
  difference: the runs list says "Rendering" instead of "Waiting for review",
  the Automations attention tab and `waitingRuns` exclude it, and
  `drainRuns` still refuses to touch it. Merging the two states would put
  "one thing is waiting on you" in front of somebody who can only wait.
- **The handler runs twice, and must know which time it is.** `StepCtx.awaiting`
  is handed to the parked step and to no other, so a re-drive reads the row it
  already queued instead of queueing a second one. The charge is keyed
  `wf:<runId>:<stepId>` as a second line of defence — a beat that re-drives
  the same run bills one clip, not one per beat.
- **`resumeRenders` (`drain.ts`) is the only caller that may claim a `waiting`
  run**, via `claimForDriving(..., { includeWaiting: true })`. It reads every
  watched clip in ONE query and claims only the runs whose clip has landed, so
  a render still in flight costs a row read and nothing else — no claim, no
  drive, no attempt spent from the run's retry budget.

`lib/video/queue.ts` is the seam both callers go through. Do NOT import the
runner (or anything else under `lib/video/` beyond `queue.ts` and
`higgsfield.ts`) from `steps.ts`: `startRendering` loads it dynamically for
exactly that reason. A static import drags the whole rendering chain —
post-production, the capture browser, the script models — into the run engine
and the preview builder. That is the `apps.ts` trap again, and it fired the
first time it was tried.

## Saying what a generation was grounded in

`ai_step`, `generate_image` and `generate_video` all read the workspace's brand
profile best-effort: an unreadable profile costs specificity, never a run. The
consequence used to be invisible — a generic draft and a brand-specific one
produced identical journals and identical approval cards. All three now stamp
`grounded` (and `brand`, when known) onto their output, `preview.ts` folds
that into `ApprovalPreview.grounding`, and the card says which of the two
happened. Read it off the JOURNAL, never off the profile as it stands now: the
profile may have been filled in since, and describing this draft with today's
facts would be describing a different draft.

## destination.ts — telling the writer where the words go

An `ai_step` knew its instruction, its upstream data and the brand, and nothing
about the channel. So one node wrote the same paragraph whether it was about to
become a LinkedIn post, a tweet, a Slack message or an email body — formatted
the way a language model formats prose when nobody says otherwise, with a
bolded title line and markdown headings, published to a real account.

`destinationOf(graph, stepId)` walks forward to the first step that actually
SENDS and returns that channel's conventions. Three rules in the walk:

- **It follows `on_approve` as well as `next`**, because draft → approve →
  publish is the shape most of these automations have, and stopping at the
  approval would leave the common case with no destination at all.
- **It stops at a `branch`/`filter` and returns null.** Which way the run goes
  is decided by data the AI step is about to produce; a confident wrong channel
  is worse than none.
- **A read `app_action` is not a destination.** It fetches; nothing is being
  written for it.

Only the engine can supply this — the graph lives there and nowhere a handler
can see it — so it is threaded through `StepCtx.destination`, computed per step
(an approval or a second draft can sit in between). In the prompt it goes AFTER
the brand block, deliberately: the brand's own voice is authoritative and this
is only the manners of the room it is spoken in.

## Display / editing / templates

`display.ts` derives the read-only UI view-model from a graph, pure and
deterministic. `edit.ts` is the visual editor's insert/delete/rewire layer as
pure `graph → graph` functions — what makes the AI builder and hand-editing
interchangeable, since both just produce a graph through the same
`validateGraph`. `layout.ts` turns a graph into canvas
coordinates — a tidy tree over the same `buildFlows()` spine/lane/join structure
`edit.ts` already produces, laid out left to right (a column per step, a lane
per branch path) — and is deliberately pure and storage-free: node positions
are re-derived on every render rather than persisted, so an AI edit or an undo
can never leave a stale layout behind. A node's box is the circle only; the
caption the canvas draws under it is outside that box, which is what the
canvas's pixel-per-side fit padding compensates for. `buildFlows()` returns the
spine first and then one lane per run of steps the trigger cannot reach, and
those lanes stack below the spine: `editor.ts`'s `draftIssues()` blocks Publish
on exactly those steps, so drawing only the reachable ones left the user an
error with no node to select, wire up or delete. Anything the validator can
name must have a node on the canvas. `templates.ts` graphs
deliberately ship with blank required fields; "Needs setup" is the intended
UX.

`limitations.ts` is the third thing the editor can say. `validateGraph`
rejects what cannot run and `missingSetup` names blank fields — between them
they cover everything the user can *fix*. `limitations()` covers what is left:
true statements about a **working** automation that will still surprise
whoever switched it on — this trigger polls rather than pushes, this app has
no Composio toolkit so the step is simulated, this provider forbids what the
step is arranged to do (a WhatsApp template cannot carry an `ai_step`'s
wording; `METAADS_GET_INSIGHTS` with a blank `object_id` depends on a setting
made under Settings → Paid channels). Pure and I/O-free like `validate.ts`,
because the editor re-derives it on every keystroke. The provider constraints
themselves live on the registry (`ToolSpec.limits`, `RealtimeSpec.needs`) so
the catalog stays the single source — they used to exist only inside `desc`,
which is written for the builder LLM and shown to nobody.

One rule about that panel, learned from a screenshot of it: **it says each
thing once.** The shipped review-reply template used to render four
paragraphs — one for the trigger, three byte-identical ones for the three
sentiment branches, which share the title "Post the reply" — all repeating
that Google Business Profile has no live connection. So `simulatedLimits()`
groups by APP rather than by step (trigger + N steps = one line, naming the
steps while their titles distinguish them and counting them once they don't),
and `dedupe()` is a final pass over the whole list, because a provider
`limits` entry repeated across identical branches has exactly the same
problem. A panel that repeats itself is a panel people learn to scroll past.

## apps.ts — which accounts an automation needs, and whether you have them

`requiredAppsOf(graph)` (trigger app + `app_action` toolkits + `social_post`
platforms) lives here rather than in `builder.ts` because all three creation
paths ask it **in the browser**: the chat preview, the template gallery, and
the editor — which asks about the graph on the canvas, not the saved one, so
dropping in a Slack block names Slack immediately. `builder.ts` pulls in the
OpenAI client and `env`, so importing it from a client component breaks the
production build while `tsc --noEmit` stays green; it re-exports these for its
server-side callers. `statusOf`/`connectionsOf`/`unconnected` are the pure
mapping from `GET /api/integrations/connect`'s rows to what the UI shows and
gates on; `src/components/connect-apps.tsx` is the shared panel + hook.

Two states are load-bearing and neither is "connected":

- **`simulated`** — an app in `SIMULATED_APPS`, or *any* app when the install
  has no `COMPOSIO_API_KEY` (`steps.ts` simulates every `app_action` then).
  It is derived from the app, never from the row, because the row lies:
  `POST /api/integrations/connect` writes a cached `connected` row for a
  toolkit-less app, so Google Business Profile answered "Connected" with a
  green check while every call against it was a fabrication. No Connect button
  is offered for one, and it never blocks anything.
- **`unknown`** — our own status endpoint did not answer. Deliberately
  non-blocking: refusing to create an automation over a network blip leaves
  the user with nothing they can do.

Everything else (`none`, `pending`) blocks creating the automation — the chat's
"Save workflow", the template dialog's "Create automation" — and switching one
on, client-side in the editor and again in `PATCH /api/workflows/[id]` (which
fails open if Composio is unreachable, since the run's own pre-check in
`steps.ts` still catches it). Before this, the first mention of a missing
account was that pre-check throwing "<app> is not connected" on a live run.

## Gotchas

- `queued` is a charged, unattended, not-yet-driven status distinct from
  success/failure — every status check, list, and stats query must account
  for it (see `store.ts`'s `updateWorkflowStats`: the old success-rate
  formula silently showed 100% for a workflow whose every run got stuck).
- `ai_step` sends more than the instruction + upstream context. It appends
  `brandContext(getBrandProfileForWorkspace(ctx.entityId))` to the system
  prompt and the step's own previous outputs (`store.ts`'s
  `recentStepOutputs`) to the user prompt. Both are load-bearing, not polish:
  without the first, "write a post customized to my business" answered with
  "Excited to share some updates from our business!" for a workspace whose
  brand profile was fully populated; without the second, a manual/schedule
  trigger contributes no data, so every run sent a byte-identical prompt and
  four consecutive runs of one automation opened with the same sentence.
  Both reads are best-effort — a missing profile or an unreadable log
  degrades the draft, it never fails the run. Because that degrading is
  invisible (the automation looks fine, the copy is just about nobody), the
  gap is now surfaced everywhere an automation is created and **blocks
  switching one on**. `needsBrandGrounding()` (`apps.ts`) is the single test
  for "does this graph generate anything" — `ai_step` or `generate_image` —
  and `GET /api/brand/readiness` is the single answer to "do we know what the
  business is", shared by the editor, the builder chat and the template dialog
  via `useBrandReadiness()`. It was a non-blocking notice for as long as there
  was no fix to point at; Settings can now re-run the site read and the deep
  research, so an automation that would publish generalities to a real
  audience on a schedule is refused instead — client-side in the editor and
  again in `PATCH /api/workflows/[id]`, which **fails open** on an unreadable
  profile exactly like the Composio check beside it. Still deliberately not a
  `setupGaps` entry: that stays pure and per-step, and this is a
  workspace-wide fact about a graph whose every field is filled.
- Pressing Run gives an `app_event_trigger` no event, so `steps.ts` feeds it
  the trigger's canned `sample` — but nothing downstream is sampled, and the
  taint rule deliberately does not treat a sample as `sim`, so the reply to the
  invented review really is published. That is a decision, not an oversight
  (otherwise an event-triggered automation could never be tried end to end), so
  it is handled where it can be consented to: `liveWrites()` (`validate.ts`)
  names the irreversible steps and the editor's Run confirms before starting.
- "Simulation taint" (`steps.ts`): output is `sim: true` if the step ran
  simulated OR anything it read from was — computed transitively in
  `engine.ts` (the only place seeing both `ctx.reads` and context), to stop
  a no-`OPENAI_API_KEY` preview draft reaching a live `social_post`/
  `app_action` write.
- A run's `graph` is snapshotted at claim time and replayed against that
  snapshot, never the workflow's current `config` — editing/saving a
  workflow mid-run must not change what that run replays against.
