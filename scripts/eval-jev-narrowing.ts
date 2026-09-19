/**
 * Compare stage-2 narrowing (`narrowIntegrations` in tool-selection.ts, a
 * single GPT JSON-mode call) against a TypeSafe/Jev alternative: one Noul
 * ("is this integration relevant?") question per retrieved candidate, fanned
 * out in a single Jev API call, thresholded to pick the same <= MAX_EXPANDED.
 *
 * Ground truth is the team's own `RETRIEVAL_CASES` fixture (20 labelled
 * requests, real `expect` sets) plus four SUPPLEMENTARY_CASES added here to
 * cover phrasing personas the fixture doesn't explicitly tag (naive/
 * non-technical, jargon-heavy/terse, over-detailed run-on). The supplementary
 * cases are hand-written and NOT team-vetted — reported separately.
 *
 * Both stages run for real: real stage-1 retrieval (`retrieveIntegrations`,
 * live Supabase `tool_index`), real narrowing call (live OpenAI), real Jev
 * call (live TypeSafe API). Nothing here is simulated.
 *
 * Run:
 *   TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) \
 *   node --env-file=.env.local --experimental-strip-types \
 *        --import ./scripts/test-register.mjs scripts/eval-jev-narrowing.ts
 */

import { retrieveIntegrations } from "@/lib/workflows/retrieval";
import { integrationDescriptions, narrowIntegrations } from "@/lib/workflows/tool-selection";
import { appLabel } from "@/lib/workflows/registry";
import { RETRIEVAL_CASES, type RetrievalCase, type CaseKind } from "../tests/fixtures/retrieval-cases.ts";

const RETRIEVE_LIMIT = 20;
const MAX_EXPANDED = 4;
const JEV_THRESHOLD = 0.5;

const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY;
if (!TYPESAFE_KEY) {
  console.error("Set TYPESAFE_API_KEY (e.g. TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) node ...)");
  process.exit(1);
}

/**
 * Hand-written, NOT from the team's fixture. Covers the persona axes asked
 * about that the real fixture doesn't explicitly tag: a naive multi-app
 * request in plain language, a terse jargon/abbreviation-heavy one, and a
 * long, over-specified power-user run-on. All slugs are ones the real
 * fixture already uses as `expect` values, so they're known to be indexed.
 */
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

/** Maps the fixture's real taxonomy onto the persona axes that were asked about. */
function personaFor(kind: CaseKind): string {
  switch (kind) {
    case "vocabulary":
      return "naive-non-technical"; // outcome described, no app named, no jargon
    case "named":
      return "technical-explicit"; // app names, enterprise/product vocabulary
    case "multi":
      return "over-detailed"; // multi-step chains, longer prompts
    case "native":
      return "technical-explicit";
    case "adversarial":
      return "naive-terse"; // deliberately vague, precision trap
  }
}

interface Case {
  prompt: string;
  expect: string[];
  kind: CaseKind;
  persona: string;
  note: string;
}

const CASES: Case[] = [
  ...RETRIEVAL_CASES.map((c) => ({ ...c, persona: personaFor(c.kind) })),
  ...SUPPLEMENTARY_CASES,
];

interface JevResult {
  picks: string[] | null;
  probs: Record<string, number>;
  latencyMs: number;
  inputTokens?: number;
  error?: string;
}

async function narrowIntegrationsJev(
  requestText: string,
  candidates: string[],
  descriptions: Map<string, string>,
): Promise<JevResult> {
  const questions: Record<string, unknown> = {};
  candidates.forEach((slug, i) => {
    questions[`q${i}`] = {
      type: "noul",
      instructions: `Is the "${appLabel(slug)}" integration (${descriptions.get(slug) ?? slug}) relevant to accomplishing this automation request?`,
      criteria: { true: `${appLabel(slug)} is needed`, false: `${appLabel(slug)} is not needed` },
    };
  });

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${TYPESAFE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ state: requestText, model: "jev-latest", questions }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return { picks: null, probs: {}, latencyMs: Date.now() - start, error: String(err) };
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) {
    return { picks: null, probs: {}, latencyMs, error: `HTTP ${res.status}: ${await res.text()}` };
  }
  const json = (await res.json()) as {
    answers?: Record<string, { noul?: number }>;
    usage?: { input_tokens?: number };
  };
  const probs: Record<string, number> = {};
  candidates.forEach((slug, i) => {
    const v = json.answers?.[`q${i}`]?.noul;
    probs[slug] = typeof v === "number" ? v : 0;
  });
  const picks = Object.entries(probs)
    .filter(([, p]) => p >= JEV_THRESHOLD)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANDED)
    .map(([slug]) => slug);
  return { picks: picks.length ? picks : [], probs, latencyMs, inputTokens: json.usage?.input_tokens };
}

interface PRF {
  precision: number;
  recall: number;
  f1: number;
  picked: string[];
}

/** Precision/recall against `expect`, restricted to what stage-1 actually retrieved — a
 *  narrowing stage cannot be blamed for an app stage 1 never showed it. */
function score(expect: string[], candidates: string[], picked: string[] | null): PRF {
  const reachableExpect = expect.filter((e) => candidates.includes(e));
  const p = picked ?? [];
  const tp = p.filter((s) => reachableExpect.includes(s)).length;
  const precision = p.length ? tp / p.length : reachableExpect.length ? 0 : 1;
  const recall = reachableExpect.length ? tp / reachableExpect.length : p.length ? 0 : 1;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1, picked: p };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

async function main() {
  const rows: Array<{
    case: Case;
    reachable: boolean;
    baseline: PRF;
    jev: PRF;
    jevProbs: Record<string, number>;
    baselineLatencyMs: number;
    jevLatencyMs: number;
    jevError?: string;
  }> = [];

  for (const c of CASES) {
    const retrieved = await retrieveIntegrations(c.prompt, { limit: RETRIEVE_LIMIT });
    const candidates = retrieved.selected;
    const descriptions = await integrationDescriptions(candidates);

    const t0 = Date.now();
    const baselinePicks = await narrowIntegrations(c.prompt, candidates, descriptions);
    const baselineLatencyMs = Date.now() - t0;

    const jevResult = await narrowIntegrationsJev(c.prompt, candidates, descriptions);

    const reachable = c.expect.every((e) => candidates.includes(e)) || c.expect.length === 0;
    rows.push({
      case: c,
      reachable,
      baseline: score(c.expect, candidates, baselinePicks),
      jev: score(c.expect, candidates, jevResult.picks),
      jevProbs: jevResult.probs,
      baselineLatencyMs,
      jevLatencyMs: jevResult.latencyMs,
      jevError: jevResult.error,
    });

    console.log(
      `${c.persona.padEnd(20)} ${c.kind.padEnd(11)} "${c.prompt.slice(0, 60)}${c.prompt.length > 60 ? "…" : ""}"`,
    );
    console.log(`  expect:   [${c.expect.join(", ")}]${reachable ? "" : "  (NOT fully reachable from stage-1 candidates)"}`);
    console.log(
      `  baseline: [${(baselinePicks ?? []).join(", ")}]  P=${rows.at(-1)!.baseline.precision.toFixed(2)} R=${rows.at(-1)!.baseline.recall.toFixed(2)} F1=${rows.at(-1)!.baseline.f1.toFixed(2)}  (${baselineLatencyMs}ms)`,
    );
    console.log(
      `  jev:      [${(jevResult.picks ?? []).join(", ")}]  P=${rows.at(-1)!.jev.precision.toFixed(2)} R=${rows.at(-1)!.jev.recall.toFixed(2)} F1=${rows.at(-1)!.jev.f1.toFixed(2)}  (${jevResult.latencyMs}ms)${jevResult.error ? `  ERROR: ${jevResult.error}` : ""}`,
    );
    console.log("");
  }

  console.log("=".repeat(100));
  console.log("AGGREGATE (all cases)");
  console.log("=".repeat(100));
  console.log(
    `baseline: precision=${mean(rows.map((r) => r.baseline.precision)).toFixed(3)} recall=${mean(rows.map((r) => r.baseline.recall)).toFixed(3)} f1=${mean(rows.map((r) => r.baseline.f1)).toFixed(3)} avgLatency=${mean(rows.map((r) => r.baselineLatencyMs)).toFixed(0)}ms`,
  );
  console.log(
    `jev:      precision=${mean(rows.map((r) => r.jev.precision)).toFixed(3)} recall=${mean(rows.map((r) => r.jev.recall)).toFixed(3)} f1=${mean(rows.map((r) => r.jev.f1)).toFixed(3)} avgLatency=${mean(rows.map((r) => r.jevLatencyMs)).toFixed(0)}ms`,
  );

  console.log("\nBY PERSONA");
  const personas = [...new Set(rows.map((r) => r.case.persona))];
  for (const persona of personas) {
    const subset = rows.filter((r) => r.case.persona === persona);
    console.log(
      `  ${persona.padEnd(20)} n=${subset.length}  baseline F1=${mean(subset.map((r) => r.baseline.f1)).toFixed(3)}  jev F1=${mean(subset.map((r) => r.jev.f1)).toFixed(3)}`,
    );
  }

  console.log("\nBY FIXTURE KIND");
  const kinds = [...new Set(rows.map((r) => r.case.kind))];
  for (const kind of kinds) {
    const subset = rows.filter((r) => r.case.kind === kind);
    console.log(
      `  ${kind.padEnd(12)} n=${subset.length}  baseline F1=${mean(subset.map((r) => r.baseline.f1)).toFixed(3)}  jev F1=${mean(subset.map((r) => r.jev.f1)).toFixed(3)}`,
    );
  }

  const jevErrors = rows.filter((r) => r.jevError);
  if (jevErrors.length) {
    console.log(`\nJEV ERRORS: ${jevErrors.length}/${rows.length}`);
    for (const r of jevErrors) console.log(`  "${r.case.prompt.slice(0, 50)}": ${r.jevError}`);
  }

  console.log("\nOutput as JSON for the research doc:\n");
  console.log(
    JSON.stringify(
      rows.map((r) => ({
        prompt: r.case.prompt,
        kind: r.case.kind,
        persona: r.case.persona,
        expect: r.case.expect,
        reachable: r.reachable,
        baseline: { picked: r.baseline.picked, ...r.baseline },
        jev: { picked: r.jev.picked, ...r.jev, probs: r.jevProbs },
        baselineLatencyMs: r.baselineLatencyMs,
        jevLatencyMs: r.jevLatencyMs,
      })),
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
