/**
 * Quick spot-check, not a scored eval: real-life-style prompts (lowercase,
 * rambling, ambiguous, no punctuation — the way someone actually types at
 * 11pm) run live through the current narrowIntegrations() and a Jev
 * Noul-fan-out, side by side. `expect` is filled in where the right answer
 * is unambiguous; left empty and noted where the prompt is deliberately
 * vague, since that's realistic too and shouldn't be force-scored.
 *
 * Run:
 *   TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) \
 *   node --env-file=.env.local --experimental-strip-types \
 *        --import ./scripts/test-register.mjs scripts/spotcheck-jev-realistic.ts
 */

import { retrieveIntegrations } from "@/lib/workflows/retrieval";
import { integrationDescriptions, narrowIntegrations } from "@/lib/workflows/tool-selection";
import { appLabel } from "@/lib/workflows/registry";

const RETRIEVE_LIMIT = 20;
const MAX_EXPANDED = 4;

const TYPESAFE_KEY = process.env.TYPESAFE_API_KEY;
if (!TYPESAFE_KEY) {
  console.error("Set TYPESAFE_API_KEY (e.g. TYPESAFE_API_KEY=$(cat ~/.jev_experiment_key) node ...)");
  process.exit(1);
}

interface Case {
  prompt: string;
  expect: string[];
  note: string;
}

const CASES: Case[] = [
  {
    prompt: "hey can u make it so like when someone dm's us on instagram it goes to our slack channel automatically thanks",
    expect: ["instagram", "slack"],
    note: "casual, abbreviation-heavy",
  },
  {
    prompt: "i need this thing where if a customer cancels their subscription in stripe someone should know about it asap on slack or email idk whatevers easier",
    expect: ["stripe"],
    note: "deliberately open on the notification channel — 'slack or email idk' — right answer includes stripe plus either/both, not a single correct set",
  },
  {
    prompt: "sync new typeform responses into airtable pls",
    expect: ["typeform", "airtable"],
    note: "terse but unambiguous",
  },
  {
    prompt: "whenever theres a new PR opened on our repo post it in engineering channel and also make a card in our board somewhere",
    expect: ["github", "slack"],
    note: "'our board somewhere' is vague on purpose — real users often don't name the tracker",
  },
  {
    prompt: "can this notify me if a github action fails on main",
    expect: ["github"],
    note: "terse, technical, single app",
  },
  {
    prompt: "add new leads from our landing page form to hubspot and shoot them a welcome email",
    expect: ["hubspot", "gmail"],
    note: "form provider unnamed — 'our landing page form' could be typeform, a native form, etc.",
  },
  {
    prompt: "when ppl leave reviews on google i want an ai reply drafted for approval b4 it goes live",
    expect: ["googlebusinessprofile"],
    note: "heavy abbreviation (ppl, b4), same intent as a fixture case but typed badly",
  },
  {
    prompt: "track sheets updates and post recap every friday",
    expect: ["googlesheets", "slack"],
    note: "'post' with no destination named — slack is a guess, not a certainty; channel unnamed",
  },
  {
    prompt: "if invoice overdue send reminder",
    expect: ["stripe"],
    note: "extremely terse, no app named, no send-channel named",
  },
  {
    prompt: "someone fills the form on our site, put it somewhere we can see and maybe slack too",
    expect: [],
    note: "genuinely underspecified — 'somewhere we can see' names nothing; scored for what a good narrower does with real ambiguity, not a fixed answer",
  },
];

async function narrowIntegrationsJev(
  requestText: string,
  candidates: string[],
  descriptions: Map<string, string>,
): Promise<{ picks: string[]; probs: Record<string, number>; latencyMs: number; error?: string }> {
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
    return { picks: [], probs: {}, latencyMs: Date.now() - start, error: String(err) };
  }
  const latencyMs = Date.now() - start;
  if (!res.ok) return { picks: [], probs: {}, latencyMs, error: `HTTP ${res.status}: ${await res.text()}` };
  const json = (await res.json()) as { answers?: Record<string, { noul?: number }> };
  const probs: Record<string, number> = {};
  candidates.forEach((slug, i) => {
    const v = json.answers?.[`q${i}`]?.noul;
    probs[slug] = typeof v === "number" ? v : 0;
  });
  const picks = Object.entries(probs)
    .filter(([, p]) => p >= 0.5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXPANDED)
    .map(([slug]) => slug);
  return { picks, probs, latencyMs };
}

async function main() {
  for (const c of CASES) {
    const retrieved = await retrieveIntegrations(c.prompt, { limit: RETRIEVE_LIMIT });
    const candidates = retrieved.selected;
    const descriptions = await integrationDescriptions(candidates);

    const t0 = Date.now();
    const baselinePicks = await narrowIntegrations(c.prompt, candidates, descriptions);
    const baselineMs = Date.now() - t0;

    const jev = await narrowIntegrationsJev(c.prompt, candidates, descriptions);

    console.log(`"${c.prompt}"`);
    console.log(`  note:     ${c.note}`);
    console.log(`  expect:   [${c.expect.join(", ") || "(deliberately open)"}]`);
    console.log(`  baseline: [${(baselinePicks ?? []).join(", ")}]  (${baselineMs}ms)`);
    console.log(`  jev:      [${jev.picks.join(", ")}]  (${jev.latencyMs}ms)${jev.error ? `  ERROR: ${jev.error}` : ""}`);
    // Show the near-miss probabilities so you can see what almost made the cut.
    const sortedProbs = Object.entries(jev.probs).sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(`  jev top probs: ${sortedProbs.map(([s, p]) => `${s}=${p.toFixed(2)}`).join(", ")}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
