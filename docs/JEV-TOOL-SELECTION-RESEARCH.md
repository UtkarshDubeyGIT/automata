# Research: could Jev replace stage-2 tool narrowing?

**Question asked:** could TypeSafe AI's model classify/select which integrations a
workflow-builder request needs, instead of (or alongside) the LLM call we use today?
**Answer: no, not as tested.** On the team's own labelled fixture, a Jev-backed
narrowing step scores *worse* than the current GPT call (F1 0.624 vs 0.714), for a
cost/latency win that doesn't matter at this call's scale. The reason is structural,
not a rough edge — see "Why it loses" below. One concrete, cheap improvement to the
*existing* GPT path fell out of this experiment regardless (see "Free win").

Branch: `research/jev-tool-selection`. Nothing here is proposed for merge as-is —
`tool-selection.ts` has two functions temporarily `export`ed so the eval script could
call the real production code path instead of a reimplementation; revert those if this
doesn't ship.

## Correction on the name

The product is **Jev**, not "GEP" — TypeSafe AI's first "System One" model, announced
2026-09-15. Source: [docs.typesafe.ai/introduction](https://docs.typesafe.ai/introduction),
[docs.typesafe.ai/models](https://docs.typesafe.ai/models),
[docs.typesafe.ai/api](https://docs.typesafe.ai/api).

## What Jev actually is

Instead of generating text, Jev evaluates typed *questions* against a *state* and
returns typed values with calibrated probabilities — one HTTP call,
`POST https://api.typesafe.ai/v1/systemone`, can carry many questions, each judged
independently in parallel against the same input:

- **Noul** — is a statement true? Returns a float in `[0, 1]`.
- **Choice** — pick one option from a labelled set. Returns the pick, a probability
  distribution over every option, and a derived confidence.
- **Score** — rate against an ordered rubric (≥2 levels). Returns a score, a
  distribution, and confidence.

Pricing is $0.042 per million input tokens, output free; rate limits are documented as
"actively in flux." Budget: 64k tokens per request (state + all questions), 32k for
state + the longest single question. This is all from the primary docs above, not
secondary sources — see the injection note below for why that distinction mattered here.

## Where this maps onto our code

`src/lib/workflows/tool-selection.ts` picks the builder's tool catalog in three stages
(see the file's own doc comment): **retrieve** (rank ~1,553 integrations down to ~20,
lexical, no LLM call) → **narrow** (`narrowIntegrations()`, one GPT JSON-mode call
picks ≤4 of those 20 the request actually needs) → **expand** (render every tool in
the chosen apps). Jev's Choice/Noul primitives are a plausible fit for the **narrow**
step specifically — that's what this research tested.

`Choice` was tried and rejected as the wrong shape first: it returns exactly *one*
option, but narrowing needs a variable-size *subset*. Asking it "which single
integration is the primary tool" on a request needing both a source and a sink is a
malformed question, not a fair test of the model — TypeSafe's own docs say to keep
questions atomic and decompose broad judgments rather than force one broad pick. The
right-shaped primitive is **Noul fanned out**: one relevance question per retrieved
candidate, all evaluated in the same call, thresholded to pick the top few. That's
what the eval below actually compares.

## Method

`scripts/eval-jev-narrowing.ts` (on this branch) runs both approaches, for real, on
the same input:

1. Real stage-1 retrieval (`retrieveIntegrations`, live Supabase `tool_index`) — every
   case gets whatever candidates the actual retriever would hand the actual narrowing
   step, not a hand-picked list.
2. **Baseline**: the real `narrowIntegrations()` (live OpenAI call, current production
   code — imported directly, not reimplemented).
3. **Jev**: one Noul question per candidate ("is `<integration>` relevant to
   accomplishing this request?"), single live API call, picks = candidates scoring
   ≥ 0.5, capped at 4, ranked by probability.

Ground truth: the team's own `tests/fixtures/retrieval-cases.ts` — 20 real, labelled,
git-blessed cases spanning `native`/`vocabulary`/`named`/`multi`/`adversarial`, plus
**4 supplementary cases I wrote for this research** to explicitly cover phrasing
personas the fixture doesn't tag (a naive/non-technical multi-app request, a terse
jargon-heavy one, an over-detailed power-user run-on, a naive one-liner). The
supplementary four are **not team-vetted** — flagged separately in every table below.
Precision/recall are scored against `expect` restricted to what stage-1 actually
retrieved, same convention as `scripts/eval-retrieval.ts`, so narrowing isn't blamed
for a retrieval miss.

All 24 cases ran with zero request failures on either side.

## Results

**Aggregate (24 cases, 20 team-labelled + 4 supplementary):**

| | precision | recall | F1 | avg latency |
|---|---|---|---|---|
| baseline (current GPT call) | 0.694 | 0.771 | **0.714** | 1480ms |
| Jev (Noul fan-out, threshold 0.5) | 0.538 | 0.833 | **0.624** | 445ms |

**By persona:**

| persona | n | baseline F1 | Jev F1 |
|---|---|---|---|
| technical-explicit (named apps, enterprise vocab) | 7 | 0.857 | 0.752 |
| naive-non-technical (outcome described, no app named) | 9 | 0.515 | 0.337 |
| over-detailed (multi-step, longer prompts) | 4 | 0.875 | **0.917** |
| naive-terse | 3 | 0.667 | 0.667 |
| technical-terse (supplementary) | 1 | 1.000 | 1.000 |

**By fixture kind** (team taxonomy):

| kind | n | baseline F1 | Jev F1 |
|---|---|---|---|
| native | 3 | 0.889 | 0.711 |
| vocabulary | 9 | 0.552 | 0.404 |
| named | 5 | 0.867 | 0.827 |
| multi | 5 | 0.833 | 0.813 |
| adversarial | 2 | 0.500 | 0.500 |

Jev wins on raw recall (0.833 vs 0.771) — it rarely misses the right app entirely —
but loses on precision by a wide margin (0.538 vs 0.694), and loses net.

## Why it loses: isolation, not the model being wrong

The worst single case makes the mechanism visible. For *"collect customer feedback
after every support conversation closes"* (expect: `intercom`):

- baseline picked `[intercom]` — F1 = 1.00
- Jev picked `[delighted, refiner, satismeter, retently]` — F1 = **0.00**, missing
  `intercom` entirely

Those four are all customer-feedback-survey competitors of Intercom. The same pattern
repeats through the `naive-non-technical` bucket: `stripe`'s siblings
(`recurly`, `maxio`, `gocardless_mcp`) all scored relevant alongside it; `hubspot`'s
siblings (`pipedrive`, `pipeline_crm`, `active_trail`) crowded it out; `calendly`'s
siblings (`planyo_online_booking`, `calendarhero`) did the same.

TypeSafe's own docs say each question is evaluated "in parallel and in isolation
against the same state" — by design, a Noul question never sees the other 39
candidates it's competing against. That's fine for genuinely independent judgments
(is this urgent? is the customer angry?), but integration catalogs are dense with
near-duplicate competing products, and "is X relevant" asked in isolation is a
different — and easier — question than "is X the one the request actually needs
*out of these 40*." The current single GPT call sees the whole candidate list at once
and can suppress siblings; that comparative framing is exactly what this task needs
and what Noul's isolation gives up. This isn't a tuning problem this eval can fix by
moving the threshold — recall goes up and precision goes down together because the
same mechanism drives both.

The one place Jev's recall lean paid off: *"summarise new Zendesk tickets... drop the
digest in a Google Doc"* (expect: `zendesk, googledrive` — the fixture's own note
flags `googledocs` as a known trap slug). Baseline picked `googledocs` and missed;
Jev's over-inclusiveness picked both `googledocs` and `googledrive`, catching the real
one by not committing to just one guess. This is also why `over-detailed` is the one
persona where Jev's F1 edges out baseline (0.917 vs 0.875) — enough explicit detail
in the request narrows each isolated judgment to roughly the right answer anyway, and
recall-leaning behavior costs less when there's less ambiguity to begin with.

## Cost and latency (real, but not the deciding factor)

Jev averaged **445ms vs 1480ms** for the baseline call — about 3.3x faster, not
TypeSafe's marketed 40-200x (that's against frontier LLMs; our baseline is already a
fast, cheap model). This *is* a real, structural win if it panned out on accuracy: this
call sits on the critical path of every build/edit/repair request. Cost is a rounding
error either way — at ~40 candidates and $0.042/Mtok, one Jev narrowing call is on the
order of $0.0001-0.0002; the existing GPT call is already cheap enough that neither
number is worth optimizing against stage 3 (rendering up to 150 tools) or the builder
call itself. Don't let a pricing pitch be the reason to adopt or reject this — the
accuracy result is.

## A free win this surfaced, independent of Jev

`narrowIntegrations()`'s prompt shows the model candidate integrations with a
one-line description and nothing about the *workspace* — it can't tell "an app this
account has already connected" from "an app that merely exists." Several of the
sibling-confusion misses above (payment processors, CRMs, survey tools) are cases
where account context would settle the tie instantly, and `RetrievalOptions.keepApps`
already threads "integrations the workspace has connected" into stage 1 — it just
never reaches the stage-2 prompt. Passing that same signal into `narrowIntegrations()`
is a small, low-risk change to the code that already exists, orthogonal to the Jev
question, and worth doing regardless of what happens with this research.

## Risk notes

- Jev is an early-access product (2026-09-15) and TypeSafe's own docs describe rate
  limits as "actively in flux." 0/24 calls failed here, but that's a small sample over
  a short window.
- Mitigating: `narrowIntegrations()` already returns `null` on any failure, and its
  caller (`selectTools`) falls back to the top of the stage-1 ranking rather than
  failing the build. A Jev-backed version would inherit the same degrade-not-break
  behavior "for free" if it were ever wired in.

## Recommendation

**Don't adopt Jev for stage-2 narrowing as tested.** It's not close enough on its
strong dimension (recall) to justify the loss on precision, and precision is what
keeps builder output from listing tools the user didn't ask for. Two follow-ups if
this is worth another pass rather than shelving:

1. Untested here: whether giving Noul questions comparative context (naming sibling
   candidates inside each question's `instructions`, so isolation is less total) or
   using `Score` instead of `Noul` (forcing a relative rank rather than N independent
   absolute judgments) closes the gap. Both are guesses, not measured — the current
   result doesn't say Jev categorically can't do this, only that the naive fan-out
   doesn't.
2. Ship the connected-integrations context fix to `narrowIntegrations()` regardless —
   it's decoupled from this whole question and should help the existing GPT path on
   exactly the failure mode found here.

## Process notes

- **Prompt injection encountered and ignored:** a `WebSearch` result during this
  research contained text formatted to mimic this session's own system messages (a
  fake model-identity change, a fake attribution instruction, a fake "auto mode"
  directive). Treated as untrusted tool output per standard practice and disregarded;
  flagged to the user at the time.
- **Live API key:** the user supplied a temporary TypeSafe API key in chat for this
  experiment, to be disabled afterward. It was kept out of the repo and out of literal
  command arguments (stored in `~/.jev_experiment_key`, outside the repo, read via
  `$(cat ...)`), but it necessarily appears in this session's own transcript since the
  user pasted it directly — worth disabling as planned rather than treating "not
  committed" as sufficient.
