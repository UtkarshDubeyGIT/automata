import { createAdminClient } from "@/lib/supabase/server";
import { embed, openaiConfigured } from "@/lib/ai/openai";
import { APP_LABELS } from "./registry";

/**
 * Stage 1 of tool selection: which integrations is this request about?
 *
 * The builder used to be handed a fixed catalog of 999 tools across 17 apps
 * on every call. This ranks Composio's whole catalog instead — ~1,553
 * integrations and ~29,921 tools — and returns the ~20 integrations worth
 * showing, which a later stage narrows further before any tool list is
 * expanded.
 *
 * WHY TOOLS ARE RANKED, NOT JUST INTEGRATIONS. This is the Tool-to-Agent
 * Retrieval design (arXiv 2511.01854). Ranking integrations by their own
 * descriptions and then drilling into the winner is the obvious approach and
 * measurably the worse one (recall@5 0.70-0.74 vs 0.83 on the same topology):
 * a one-line integration blurb is a lossy filter applied before any
 * tool-level signal is read. "File a ticket for every crash report" matches a
 * Linear TOOL; Linear's own description mentions neither tickets nor crashes.
 * So `tool_index` holds both entity types in one embedding space, and a
 * matching tool is rolled up to the integration that owns it.
 */

/** Ranked integrations to return before force-includes are unioned in. */
const DEFAULT_LIMIT = 20;

/**
 * Entities considered before roll-up. Must be far above the integration limit:
 * GitHub alone owns ~781 indexed tools, so a small pool is spent entirely on a
 * handful of popular toolkits. Measured at 400 the roll-up returned only 8
 * integrations and missed apps the request had named outright.
 */
const CANDIDATE_POOL = 1500;

/*
 * NO INSTRUCTION PREFIX ON THE QUERY — measured, against expectation.
 *
 * ToolRet (43k tools, arXiv 2503.01763) reports prepending the retrieval task
 * to the query as the cheapest available win, taking BM25 from 22.32 to 36.46
 * NDCG@10. Tried here, it made dense retrieval WORSE: 44.8% -> 34.5%
 * recall@20 on the fixture. The models that gained in that paper
 * (e5-mistral-instruct, gte-Qwen2-instruct, NV-Embed) are instruction-tuned
 * and consume a task description as a distinct field;
 * `text-embedding-3-small` is not, so an instruction is simply eight more
 * content words diluting a one-sentence query. The finding does not transfer
 * to this encoder, and re-adding it needs a measurement, not a citation.
 */

export type RetrievalMode = "hybrid" | "dense" | "lexical";

/**
 * Lexical, and that is a measured result rather than a shortcut.
 *
 * The index carries embeddings and the dense half works; it loses. Scored on
 * tests/fixtures/retrieval-cases.ts against the full 31k-entity index
 * (recall@20, retrieval only):
 *
 *     lexical  79.3%   vocabulary 72.7%   multi 100%    484ms
 *     hybrid   69.0%   vocabulary 54.5%   multi  87.5%  812ms
 *     dense    37.9%   vocabulary 27.3%   multi  25%    699ms
 *
 * Dense loses even on `vocabulary` — requests naming no app at all, the case
 * semantic search exists for — which matches ToolRet (arXiv 2503.01763)
 * finding that general-purpose embedding models transfer poorly to tool
 * retrieval. So a build makes no embedding call: cheaper, faster, one less
 * provider on the critical path.
 *
 * The dense path stays reachable through `mode` so scripts/eval-retrieval.ts
 * can re-run this comparison when the corpus or the encoder changes. Flipping
 * this default is a measurement, not an opinion.
 */
const DEFAULT_MODE: RetrievalMode = "lexical";

export interface RetrievalOptions {
  /**
   * Integrations that must appear whatever the ranking says — the apps behind
   * a workflow being edited, and anything the workspace has already
   * connected.
   */
  keepApps?: Iterable<string>;
  limit?: number;
  /** Evaluation harness only; production always uses the default. */
  mode?: RetrievalMode;
  /** Evaluation harness only: skip the registry force-include to measure raw ranking. */
  skipRegistryFloor?: boolean;
}

export interface RetrievalResult {
  /**
   * Integrations the index actually ranked, best first. Reported separately
   * from `selected` so retrieval quality can be measured without the
   * force-includes flattering it — most of the registry floor would otherwise
   * count as a successful retrieval of apps that were never ranked at all.
   */
  ranked: string[];
  /** Force-included slugs that the ranking did not produce. */
  forced: string[];
  /** What the next stage is actually shown: `ranked` ∪ `forced`. */
  selected: string[];
  mode: RetrievalMode;
  /** True when the embedding half was unavailable and this fell back to lexical. */
  degraded: boolean;
}

/**
 * Apps we ship hand-verified tool specs for.
 *
 * Always included, for two reasons. Composio does not carry all of them —
 * `googlebusinessprofile` and `vikunja` both 404 on its toolkits endpoint
 * because they run through `native-tools.ts` rather than Composio — so no
 * amount of ranking over the Composio index can ever surface them. And for
 * the rest, a curated spec is strictly better than a derived one, so dropping
 * a curated app because the ranking preferred a stranger would be a
 * regression against today's behaviour.
 */
function registryFloor(): string[] {
  return Object.keys(APP_LABELS);
}

/** Rolled-up integration rows as returned by `tool_index_search`. */
interface SearchRow {
  slug: string;
  score: number;
}

export async function retrieveIntegrations(
  requestText: string,
  options: RetrievalOptions = {},
): Promise<RetrievalResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const requested = options.mode ?? DEFAULT_MODE;

  let vector: number[] | null = null;
  let degraded = false;
  if (requested !== "lexical" && openaiConfigured) {
    try {
      vector = (await embed([requestText]))[0] ?? null;
    } catch (err) {
      // Lexical alone still returns candidates; a thrown error here would
      // return none, and an empty catalog is a guaranteed failed build.
      console.error("[retrieval] embedding failed, falling back to lexical:", err);
    }
  }
  if (requested !== "lexical" && !vector) degraded = true;

  const mode: RetrievalMode = vector ? requested : "lexical";

  let ranked: string[] = [];
  try {
    const db = createAdminClient();
    const { data, error } = await db.rpc("tool_index_search", {
      query_embedding: vector ? JSON.stringify(vector) : null,
      query_text: requestText,
      match_count: CANDIDATE_POOL,
      top_k: limit,
      mode,
    });
    if (error) throw new Error(error.message);
    ranked = ((data ?? []) as SearchRow[]).map((r) => r.slug);
  } catch (err) {
    // The registry floor below still yields a usable catalog — the same one
    // the builder had before any of this existed.
    console.error("[retrieval] index search failed, using registry floor only:", err);
    degraded = true;
  }

  const rankedSet = new Set(ranked);
  const forced: string[] = [];
  const addForced = (slug: string) => {
    if (!slug || rankedSet.has(slug) || forced.includes(slug)) return;
    forced.push(slug);
  };
  if (!options.skipRegistryFloor) registryFloor().forEach(addForced);
  for (const slug of options.keepApps ?? []) addForced(slug);

  return { ranked, forced, selected: [...ranked, ...forced], mode, degraded };
}
