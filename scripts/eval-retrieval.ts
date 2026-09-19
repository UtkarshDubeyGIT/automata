/**
 * Measure stage-1 integration retrieval against the labelled fixture.
 *
 *   node --env-file=.env.local --experimental-strip-types \
 *        --import ./scripts/test-register.mjs scripts/eval-retrieval.ts
 *
 * This is the harness the plan's ship/no-ship decision rests on. It scores
 * lexical-only, dense-only and the hybrid Tool-to-Agent roll-up on the same
 * cases, because the tool-retrieval literature genuinely splits on which wins
 * (BM25 leads on ToolBench, dense leads on ToolE/Gorilla) and only our own
 * corpus settles it. If hybrid does not beat lexical here, the embedding
 * index is not worth its upkeep and should be deleted.
 *
 * Two recall numbers are reported and they measure different things:
 *
 *   retrieval  — over `ranked`, the slugs the index actually produced, and
 *                only counting expectations that exist in the index at all.
 *                This is retrieval quality with nothing propping it up.
 *   end-to-end — over `selected`, after force-includes. This is what the
 *                builder really sees, and it is the number that matters for
 *                whether a workflow can be built — but it flatters retrieval,
 *                because most of our curated apps are force-included whether
 *                or not the ranking found them.
 */

import { retrieveIntegrations, type RetrievalMode } from "@/lib/workflows/retrieval";
import { createAdminClient } from "@/lib/supabase/server";
import { TOOLS } from "@/lib/workflows/registry";
import {
  EDIT_CASES,
  MUST_NOT_SURFACE,
  RETRIEVAL_CASES,
  type CaseKind,
} from "../tests/fixtures/retrieval-cases.ts";

const MODES: RetrievalMode[] = ["lexical", "dense", "hybrid"];
const LIMIT = 20;

/** Which expected slugs are actually in the index — the rest can only ever arrive via force-include. */
async function indexedSlugs(want: string[]): Promise<Set<string>> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("tool_index")
    .select("slug")
    .eq("kind", "integration")
    .in("slug", want);
  if (error) throw new Error(`index lookup failed: ${error.message}`);
  return new Set((data ?? []).map((r) => (r as { slug: string }).slug));
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

async function main() {
  const allExpected = [
    ...new Set([
      ...RETRIEVAL_CASES.flatMap((c) => c.expect),
      ...EDIT_CASES.flatMap((c) => c.expect),
    ]),
  ];
  const inIndex = await indexedSlugs(allExpected);
  const notInIndex = allExpected.filter((s) => !inIndex.has(s));
  if (notInIndex.length) {
    console.info(
      `note: ${notInIndex.length} expected integrations are absent from the Composio index ` +
        `and are reachable only via force-include: ${notInIndex.join(", ")}\n`,
    );
  }

  for (const mode of MODES) {
    console.info(`\n=== ${mode} ===`);
    let retrievalHits = 0;
    let retrievalTotal = 0;
    let e2eHits = 0;
    let e2eTotal = 0;
    const misses: string[] = [];
    const precisionFailures: string[] = [];
    let latencyTotal = 0;
    // Per kind, because the mean hides the only comparison that decides
    // anything: lexical should win `named`, and dense only earns its cost if
    // it wins `vocabulary`.
    const byKind = new Map<CaseKind, { hits: number; total: number }>();

    for (const testCase of RETRIEVAL_CASES) {
      const started = Date.now();
      const result = await retrieveIntegrations(testCase.prompt, { mode, limit: LIMIT });
      latencyTotal += Date.now() - started;

      const rankedSet = new Set(result.ranked);
      const selectedSet = new Set(result.selected);

      // Retrieval-only: score against what the index could possibly return.
      const kindTally = byKind.get(testCase.kind) ?? { hits: 0, total: 0 };
      for (const want of testCase.expect) {
        if (!inIndex.has(want)) continue;
        retrievalTotal++;
        kindTally.total++;
        if (rankedSet.has(want)) {
          retrievalHits++;
          kindTally.hits++;
        } else {
          misses.push(`[${testCase.kind}] ${want} <- "${testCase.prompt.slice(0, 50)}…"`);
        }
      }
      byKind.set(testCase.kind, kindTally);
      for (const want of testCase.expect) {
        e2eTotal++;
        if (selectedSet.has(want)) e2eHits++;
      }

      for (const banned of MUST_NOT_SURFACE[testCase.prompt] ?? []) {
        // Curated apps are force-included by design, so only a RANKED
        // appearance counts as the retriever over-reaching.
        if (rankedSet.has(banned)) {
          precisionFailures.push(`${banned} surfaced for "${testCase.prompt.slice(0, 45)}…"`);
        }
      }
    }

    // Edit flow: the instruction never names the app already in the graph, so
    // this only passes if keepApps is threaded through.
    let editHits = 0;
    let editTotal = 0;
    for (const editCase of EDIT_CASES) {
      const keepApps = editCase.existingTools
        .map((slug) => TOOLS[slug]?.app)
        .filter((v): v is string => !!v);
      const result = await retrieveIntegrations(editCase.instruction, { mode, limit: LIMIT, keepApps });
      const selected = new Set(result.selected);
      for (const want of editCase.expect) {
        editTotal++;
        if (selected.has(want)) editHits++;
      }
    }

    console.info(`  recall@${LIMIT} (retrieval only): ${pct(retrievalHits / (retrievalTotal || 1))} (${retrievalHits}/${retrievalTotal})`);
    console.info(`  recall@${LIMIT} (end-to-end):     ${pct(e2eHits / (e2eTotal || 1))} (${e2eHits}/${e2eTotal})`);
    console.info(`  edit-flow recall:                ${pct(editHits / (editTotal || 1))} (${editHits}/${editTotal})`);
    console.info(`  avg latency:                     ${(latencyTotal / RETRIEVAL_CASES.length).toFixed(0)}ms`);
    const kinds = [...byKind.entries()]
      .filter(([, v]) => v.total > 0)
      .map(([k, v]) => `${k} ${pct(v.hits / v.total)} (${v.hits}/${v.total})`);
    console.info(`  by kind:                         ${kinds.join("  |  ")}`);
    if (precisionFailures.length) {
      console.info(`  PRECISION FAILURES (${precisionFailures.length}):`);
      for (const f of precisionFailures) console.info(`    - ${f}`);
    }
    if (misses.length) {
      console.info(`  missed (${misses.length}):`);
      for (const m of misses.slice(0, 15)) console.info(`    - ${m}`);
    }
  }
}

await main();
