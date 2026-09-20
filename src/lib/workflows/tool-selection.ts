import { chat } from "@/lib/ai/openai";
import { createAdminClient } from "@/lib/supabase/server";
import { listToolsForToolkit } from "@/lib/social/composio";
import { appLabel, renderToolLine, TOOLS, tokenize, type ToolSpec } from "./registry";
import { retrieveIntegrations } from "./retrieval";

/**
 * Picks the tools the workflow-builder LLM is shown, in three stages.
 *
 *   1. retrieve  — rank Composio's whole catalog (~1,553 integrations,
 *                  ~29,921 tools) down to ~20 integrations. See retrieval.ts.
 *   2. narrow    — one cheap model call picks the few the request truly needs.
 *   3. expand    — pull every tool in those few and render them in full.
 *
 * The shape matters: stage 1 is recall-oriented and cheap per candidate, so
 * it can afford to be generous; stage 3 is precision-oriented and expensive
 * per candidate, so it only ever runs on a handful. Showing all ~30k tools
 * would be ~2M tokens, and showing only a fixed 999 (what this replaces)
 * meant 16 apps could never be automated at all.
 */

/** Integrations handed to the narrowing call. */
const RETRIEVE_LIMIT = 20;

/** Integrations whose tools get expanded. */
const MAX_EXPANDED = 4;

/**
 * Ceiling on tools rendered for a single integration. Some toolkits are
 * enormous — GitHub alone has 893 — and expanding one wholesale would
 * recreate the oversized-prompt problem this pipeline exists to fix.
 */
const PER_INTEGRATION_CAP = 60;

/**
 * Rough ceiling across all chosen integrations, so the catalog does not grow
 * linearly with how many apps the request happens to touch. Measured: two
 * expanded integrations render ~60KB, so four at the per-integration cap
 * would be back in the range this work set out to escape.
 */
const TOTAL_TOOL_BUDGET = 150;

/**
 * Never go below this per integration however many were chosen — an app
 * represented by a handful of its actions is usually an app the model cannot
 * actually use.
 */
const MIN_PER_INTEGRATION = 25;

function perIntegrationCap(chosenCount: number): number {
  if (chosenCount <= 1) return PER_INTEGRATION_CAP;
  const share = Math.floor(TOTAL_TOOL_BUDGET / chosenCount);
  return Math.min(PER_INTEGRATION_CAP, Math.max(MIN_PER_INTEGRATION, share));
}

/** Tools requested per toolkit from Composio. No `search`, so the response stays cacheable. */
const FETCH_LIMIT = 300;

export interface SelectedTools {
  /** Rendered catalog for the system prompt. */
  text: string;
  /** Integrations whose tools were expanded. */
  integrations: string[];
  /**
   * Specs for everything rendered, including tools absent from curated
   * `TOOLS`. The builder attaches these to the graph as `tool_spec` so
   * validation and the engine can resolve a tool nobody hand-wrote an entry
   * for.
   */
  specs: Record<string, ToolSpec>;
  /** True when some stage fell back — the catalog is still usable, just broader. */
  degraded: boolean;
}

/**
 * One-line description per integration, for the narrowing call.
 *
 * Exported (only from `integrationDescriptions` and `narrowIntegrations`, not
 * `selectTools`'s other internals) so scripts/eval-jev-narrowing.ts can run
 * the real narrowing prompt against real retrieval output rather than a
 * hand-rolled reimplementation that would drift from production. Research
 * branch only — revert on merge/discard if this doesn't ship.
 */
export async function integrationDescriptions(slugs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!slugs.length) return out;
  try {
    const db = createAdminClient();
    const { data, error } = await db
      .from("tool_index")
      .select("slug, doc")
      .eq("kind", "integration")
      .in("slug", slugs);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { slug: string; doc: string }[]) {
      out.set(row.slug, row.doc.slice(0, 200));
    }
  } catch (err) {
    console.error("[tool-selection] could not read integration descriptions:", err);
  }
  // Native apps are not in the Composio index at all, and anything the index
  // missed still needs a label rather than a blank line.
  for (const slug of slugs) if (!out.has(slug)) out.set(slug, appLabel(slug));
  return out;
}

/**
 * Stage 2: ask the model which of the retrieved integrations the request
 * actually needs.
 *
 * Returns `null` rather than throwing when the call fails or answers
 * unusably — the caller then falls back to the top of the ranking, which is
 * broader than ideal but always buildable. A failed narrowing must never mean
 * an empty catalog.
 */
export async function narrowIntegrations(
  requestText: string,
  candidates: string[],
  descriptions: Map<string, string>,
): Promise<string[] | null> {
  const list = candidates.map((s) => `- ${s}: ${descriptions.get(s) ?? s}`).join("\n");
  const prompt =
    `You are selecting which app integrations an automation needs.\n\n` +
    `AVAILABLE INTEGRATIONS:\n${list}\n\n` +
    `Reply with ONLY a JSON object: {"apps": ["slug", ...]}\n` +
    `Choose at most ${MAX_EXPANDED} slugs, copied exactly from the list above. ` +
    `Include an app only if the request genuinely needs it. Fewer is better.`;

  try {
    const raw = await chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: requestText },
      ],
      { json: true, maxTokens: 200, timeoutMs: 20_000 },
    );
    const parsed = JSON.parse(raw) as { apps?: unknown };
    if (!Array.isArray(parsed.apps)) return null;
    const allowed = new Set(candidates);
    // Only slugs from the list we offered. A model that invents one would
    // otherwise send us fetching a toolkit that does not exist.
    const picked = parsed.apps
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => allowed.has(a));
    return picked.length ? picked.slice(0, MAX_EXPANDED) : null;
  } catch (err) {
    console.error("[tool-selection] narrowing failed, using ranking order:", err);
    return null;
  }
}

/**
 * Rank an integration's tools against the request so the per-integration cap
 * keeps the useful ones.
 *
 * Crude on purpose — idf over the request's words, the same scoring the old
 * GitHub-only filter used. It is deciding which 60 of an app's tools to show
 * the model, not which tool to call, and the model still sees every one it
 * gets in full.
 */
function rankTools(
  tools: Array<{ slug: string; spec: ToolSpec }>,
  requestText: string,
  cap: number,
): Array<{ slug: string; spec: ToolSpec }> {
  if (tools.length <= cap) return tools;

  const docs = tools.map((t) => new Set(tokenize(`${t.slug} ${t.spec.desc}`)));
  const df = new Map<string, number>();
  for (const doc of docs) for (const w of doc) df.set(w, (df.get(w) ?? 0) + 1);

  const words = tokenize(requestText);
  const scored = tools.map((tool, i) => {
    let score = 0;
    for (const w of words) {
      if (!docs[i].has(w)) continue;
      score += Math.log((tools.length + 1) / ((df.get(w) ?? 0) + 1));
    }
    // A hand-curated tool outranks a derived one at equal relevance: its
    // kind/external/argHint were verified by a person.
    if (TOOLS[tool.slug]) score += 0.5;
    return { tool, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, cap).map((s) => s.tool);
}

export interface SelectToolsOptions {
  /**
   * Integrations that must be expanded whatever the ranking or the narrowing
   * call decides — the apps a workflow being edited already uses. Without
   * this, "add a Slack message after this" drops the GitHub tool belonging to
   * the step being edited, and the model cannot reference its own graph.
   */
  keepApps?: Iterable<string>;
  /** Tool slugs that must be rendered even if their app's cap would cut them. */
  keepSlugs?: Iterable<string>;
}

export async function selectTools(
  requestText: string,
  options: SelectToolsOptions = {},
): Promise<SelectedTools> {
  const keepApps = [...new Set(options.keepApps ?? [])];
  const keepSlugs = new Set(options.keepSlugs ?? []);

  const retrieved = await retrieveIntegrations(requestText, {
    limit: RETRIEVE_LIMIT,
    keepApps,
  });
  let degraded = retrieved.degraded;

  const descriptions = await integrationDescriptions(retrieved.selected);
  const narrowed = await narrowIntegrations(requestText, retrieved.selected, descriptions);
  if (!narrowed) degraded = true;

  // Apps the caller pinned are not up for debate; they lead, and the
  // narrowing result (or the head of the ranking) fills the rest.
  const chosen: string[] = [...keepApps];
  for (const slug of narrowed ?? retrieved.selected) {
    if (chosen.length >= MAX_EXPANDED) break;
    if (!chosen.includes(slug)) chosen.push(slug);
  }

  // Fetched together — these are independent network calls and doing them in
  // sequence put several seconds on every build. Results are consumed in
  // `chosen` order so the rendered catalog stays deterministic.
  const fetched = await Promise.all(
    chosen.map(async (app) => {
      try {
        return { app, tools: await listToolsForToolkit(app, { limit: FETCH_LIMIT }) };
      } catch (err) {
        console.error(`[tool-selection] could not list tools for ${app}:`, err);
        return { app, tools: null };
      }
    }),
  );

  const specs: Record<string, ToolSpec> = {};
  const lines: string[] = [];
  // Shared across the chosen apps, so a four-app request does not render four
  // times the catalog of a one-app request.
  const cap = perIntegrationCap(fetched.filter((f) => f.tools?.length).length);
  for (const { tools } of fetched) {
    if (!tools) {
      degraded = true;
      continue;
    }
    if (!tools.length) continue;

    const pinned = tools.filter((t) => keepSlugs.has(t.slug));
    const ranked = rankTools(
      tools.filter((t) => !keepSlugs.has(t.slug)),
      requestText,
      cap,
    );
    for (const { slug, spec } of [...pinned, ...ranked]) {
      if (specs[slug]) continue;
      specs[slug] = spec;
      lines.push(renderToolLine(slug, spec));
    }
  }

  /*
   * Last-resort floor. Every stage above degrades toward a broader catalog
   * rather than a narrower one, but if Composio is unreachable for every
   * chosen app there is still nothing to show — and an empty AVAILABLE APP
   * ACTIONS block is a guaranteed failed build, not a degraded one. The
   * curated registry is exactly the catalog the builder had before any of
   * this existed.
   */
  if (!lines.length) {
    degraded = true;
    for (const [slug, spec] of Object.entries(TOOLS)) {
      specs[slug] = spec;
      lines.push(renderToolLine(slug, spec));
    }
  }

  return { text: lines.join("\n"), integrations: chosen, specs, degraded };
}
