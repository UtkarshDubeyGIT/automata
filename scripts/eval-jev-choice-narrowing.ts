/**
 * Three-way comparison for stage-2 narrowing: current narrowIntegrations()
 * (GPT), Jev Noul-fan-out (one isolated yes/no per candidate — the approach
 * in eval-jev-narrowing.ts), and Jev Choice (one comparative call over ALL
 * candidates at once, whose probability distribution is thresholded to pick
 * the top few, instead of only reading its single top-1 `choice`).
 *
 * Motivation: eval-jev-narrowing.ts's own data showed isolated Noul scores
 * for near-duplicate candidates (jira/sentry/linear/request_tracker)
 * clustered at 0.86-0.87 with no separation, while a single Choice call over
 * the same candidates produced 0.50/0.41/0.01/0.06 - real separation,
 * because Choice's probabilities must sum to ~1 across every option given,
 * forcing genuine competition instead of N independent absolute judgments.
 * This tests whether that comparative signal narrows better in practice.
 *
 * Ground truth, methodology, and case set are identical to
 * eval-jev-narrowing.ts: the team's 20 labelled RETRIEVAL_CASES plus 4
 * hand-written supplementary persona cases (not team-vetted, same caveat).
 *
 * Run:
 *   TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) \
 *   node --env-file=.env.local --experimental-strip-types \
 *        --import ./scripts/test-register.mjs scripts/eval-jev-choice-narrowing.ts
 */

import { retrieveIntegrations } from "@/lib/workflows/retrieval";
import { integrationDescriptions, narrowIntegrations } from "@/lib/workflows/tool-selection";
import { RETRIEVAL_CASES, type RetrievalCase, type CaseKind } from "../tests/fixtures/retrieval-cases.ts";

const RETRIEVE_LIMIT = 20;
const MAX_EXPANDED = 4;
const NOUL_THRESHOLD = 0.5;
const CHOICE_MIN_PROB = 0.05; // drop pure noise from a 20-40-way distribution

const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY;
if (!TYPESAFE_KEY) {
  console.error("Set TYPESAFE_API_KEY (e.g. TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) node ...)");
  process.exit(1);
}

const SUPPLEMENTARY_CASES: (RetrievalCase & { persona: string })[] = [
  {
    prompt: "somebody fills out our contact form, add them to our email list and ping me on slack",
    expect: ["typeform", "mailchimp", "slack"],
    kind: "multi",
    note: "supplementary: naive/non-technical phrasing of a 3-app chain",
    persona: "naive-non-technical",
  },
  {
    prompt: "gh pr merged to main -> slack #eng",
    expect: ["github", "slack"],
    kind: "named",
    note: "supplementary: terse, abbreviation-heavy, technical",
    persona: "technical-terse",
  },
  {
    prompt:
      "Whenever a new deal in HubSpot moves into the 'Closed Won' stage, automatically create a new customer record row in our Airtable base under the 'Active Customers' table, then post a nicely formatted congratulatory message in our #sales-wins Slack channel tagging the account owner, and also send a personalized thank-you email via Gmail to the primary contact listed on the deal.",
    expect: ["hubspot", "airtable", "slack", "gmail"],
    kind: "multi",
    note: "supplementary: over-detailed power-user run-on, 4 apps",
    persona: "over-detailed",
  },
  {
    prompt: "someone new joins slack, welcome them",
    expect: ["slack"],
    kind: "vocabulary",
    note: "supplementary: naive, single-app, minimal detail",
    persona: "naive-terse",
  },
];

function personaFor(kind: CaseKind): string {
  switch (kind) {
    case "vocabulary":
      return "naive-non-technical";
    case "named":
      return "technical-explicit";
    case "multi":
      return "over-detailed";
    case "native":
      return "technical-explicit";
    case "adversarial":
      return "naive-terse";
  }
}

interface Case {
  prompt: string;
  expect: string[];
  kind: CaseKind;
  persona: string;
}

const CASES: Case[] = [
  ...RETRIEVAL_CASES.map((c) => ({ ...c, persona: personaFor(c.kind) })),
  ...SUPPLEMENTARY_CASES,
];

interface JevOutcome {
  picks: string[];
  probs: Record<string, number>;
  latencyMs: number;
  error?: string;
}

async function callJev(body: unknown): Promise<{ json: Record<string, unknown> | null; latencyMs: number; error?: string }> {
  const start = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${TYPESAFE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { json: null, latencyMs: Date.now() - start, error: String(err) };
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) return { json: null, latencyMs, error: `HTTP ${res.status}: ${await res.text()}` };
  return { json: (await res.json()) as Record<string, unknown>, latencyMs };
}

/** Isolated per-candidate Noul fan-out — same approach as eval-jev-narrowing.ts. */
async function narrowJevNoul(requestText: string, candidates: string[], descriptions: Map<string, string>): Promise<JevOutcome> {
  const questions: Record<string, unknown> = {};
  candidates.forEach((slug, i) => {
    questions[`q${i}`] = {
      type: "noul",
      instructions: `Is the "${slug}" integration (${descriptions.get(slug) ?? slug}) relevant to accomplishing this automation request?`,
      criteria: { true: "needed", false: "not needed" },
    };
  });
  const { json, latencyMs, error } = await callJev({ state: requestText, model: "jev-latest", questions });
  if (!json) return { picks: [], probs: {}, latencyMs, error };
  const answers = json.answers as Record<string, { noul?: number }> | undefined;
  const probs: Record<string, number> = {};
  candidates.forEach((slug, i) => {
    const v = answers?.[`q${i}`]?.noul;
    probs[slug] = typeof v === "number" ? v : 0;
  });
  const picks = Object.entries(probs)
    .filter(([, p]) => p >= NOUL_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANDED)
    .map(([slug]) => slug);
  return { picks, probs, latencyMs };
}

/** One comparative Choice call over ALL candidates, thresholded on the full distribution. */
async function narrowJevChoice(requestText: string, candidates: string[], descriptions: Map<string, string>): Promise<JevOutcome> {
  const criteria: Record<string, string> = {};
  candidates.forEach((slug) => {
    criteria[slug] = (descriptions.get(slug) ?? slug).slice(0, 150);
  });
  const body = {
    state: requestText,
    model: "jev-latest",
    questions: {
      pick: {
        type: "choice",
        instructions:
          "Which single app integration is most essential to accomplishing this automation request? " +
          "Some requests genuinely need more than one app to work end to end — in that case still pick " +
          "the single most central one, but the full probability distribution over every option is what " +
          "actually matters here, not just your top pick.",
        criteria,
      },
    },
  };
  const { json, latencyMs, error } = await callJev(body);
  if (!json) return { picks: [], probs: {}, latencyMs, error };
  const answers = json.answers as { pick?: { probabilities?: Record<string, number> } } | undefined;
  const probs = answers?.pick?.probabilities ?? {};
  const picks = Object.entries(probs)
    .filter(([, p]) => p >= CHOICE_MIN_PROB)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANDED)
    .map(([slug]) => slug);
  return { picks, probs, latencyMs };
}

interface PRF {
  precision: number;
  recall: number;
  f1: number;
}

function score(expect: string[], candidates: string[], picked: string[] | null): PRF {
  const reachableExpect = expect.filter((e) => candidates.includes(e));
  const p = picked ?? [];
  const tp = p.filter((s) => reachableExpect.includes(s)).length;
  const precision = p.length ? tp / p.length : reachableExpect.length ? 0 : 1;
  const recall = reachableExpect.length ? tp / reachableExpect.length : p.length ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function main() {
  const rows: Array<{
    case: Case;
    baseline: PRF;
    noul: PRF;
    choice: PRF;
    baselineMs: number;
    noulMs: number;
    choiceMs: number;
    choiceError?: string;
    noulError?: string;
  }> = [];

  for (const c of CASES) {
    const retrieved = await retrieveIntegrations(c.prompt, { limit: RETRIEVE_LIMIT });
    const candidates = retrieved.selected;
    const descriptions = await integrationDescriptions(candidates);

    const t0 = Date.now();
    const baselinePicks = await narrowIntegrations(c.prompt, candidates, descriptions);
    const baselineMs = Date.now() - t0;

    const noul = await narrowJevNoul(c.prompt, candidates, descriptions);
    const choice = await narrowJevChoice(c.prompt, candidates, descriptions);

    const baselineScore = score(c.expect, candidates, baselinePicks);
    const noulScore = score(c.expect, candidates, noul.picks);
    const choiceScore = score(c.expect, candidates, choice.picks);

    rows.push({
      case: c,
      baseline: baselineScore,
      noul: noulScore,
      choice: choiceScore,
      baselineMs,
      noulMs: noul.latencyMs,
      choiceMs: choice.latencyMs,
      choiceError: choice.error,
      noulError: noul.error,
    });

    console.log(`${c.persona.padEnd(20)} ${c.kind.padEnd(11)} "${c.prompt.slice(0, 55)}${c.prompt.length > 55 ? "…" : ""}"`);
    console.log(`  expect:   [${c.expect.join(", ")}]`);
    console.log(`  baseline: [${(baselinePicks ?? []).join(", ")}]  F1=${baselineScore.f1.toFixed(2)}  (${baselineMs}ms)`);
    console.log(`  noul:     [${noul.picks.join(", ")}]  F1=${noulScore.f1.toFixed(2)}  (${noul.latencyMs}ms)${noul.error ? ` ERR:${noul.error}` : ""}`);
    console.log(`  choice:   [${choice.picks.join(", ")}]  F1=${choiceScore.f1.toFixed(2)}  (${choice.latencyMs}ms)${choice.error ? ` ERR:${choice.error}` : ""}`);
    const topProbs = Object.entries(choice.probs).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  choice top probs: ${topProbs.map(([s, p]) => `${s}=${p.toFixed(2)}`).join(", ")}`);
    console.log("");
  }

  console.log("=".repeat(100));
  console.log("AGGREGATE");
  console.log("=".repeat(100));
  console.log(
    `baseline: precision=${mean(rows.map((r) => r.baseline.precision)).toFixed(3)} recall=${mean(rows.map((r) => r.baseline.recall)).toFixed(3)} f1=${mean(rows.map((r) => r.baseline.f1)).toFixed(3)} avgLatency=${mean(rows.map((r) => r.baselineMs)).toFixed(0)}ms`,
  );
  console.log(
    `noul:     precision=${mean(rows.map((r) => r.noul.precision)).toFixed(3)} recall=${mean(rows.map((r) => r.noul.recall)).toFixed(3)} f1=${mean(rows.map((r) => r.noul.f1)).toFixed(3)} avgLatency=${mean(rows.map((r) => r.noulMs)).toFixed(0)}ms`,
  );
  console.log(
    `choice:   precision=${mean(rows.map((r) => r.choice.precision)).toFixed(3)} recall=${mean(rows.map((r) => r.choice.recall)).toFixed(3)} f1=${mean(rows.map((r) => r.choice.f1)).toFixed(3)} avgLatency=${mean(rows.map((r) => r.choiceMs)).toFixed(0)}ms`,
  );

  console.log("\nBY PERSONA");
  for (const persona of [...new Set(rows.map((r) => r.case.persona))]) {
    const subset = rows.filter((r) => r.case.persona === persona);
    console.log(
      `  ${persona.padEnd(20)} n=${subset.length}  baseline F1=${mean(subset.map((r) => r.baseline.f1)).toFixed(3)}  noul F1=${mean(subset.map((r) => r.noul.f1)).toFixed(3)}  choice F1=${mean(subset.map((r) => r.choice.f1)).toFixed(3)}`,
    );
  }

  const errs = rows.filter((r) => r.choiceError || r.noulError);
  if (errs.length) {
    console.log(`\nERRORS: ${errs.length}/${rows.length}`);
    for (const r of errs) console.log(`  "${r.case.prompt.slice(0, 40)}" noul:${r.noulError ?? "-"} choice:${r.choiceError ?? "-"}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
