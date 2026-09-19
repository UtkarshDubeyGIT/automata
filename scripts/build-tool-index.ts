/**
 * Build the semantic retrieval index over Composio's full catalog.
 *
 *   node --env-file=.env.local --experimental-strip-types scripts/build-tool-index.ts
 *
 * Pages every toolkit and every tool Composio exposes (~1,553 and ~29,921 at
 * time of writing), embeds each one, and upserts into `public.tool_index`.
 *
 * Deliberately standalone: it imports the Supabase and OpenAI SDKs directly
 * rather than anything under `@/lib`, so it does not drag the Next module
 * graph through the strip-types loader.
 *
 * Resumable. Re-running skips anything already embedded unless --force is
 * passed, because the expensive half is the ~30k embeddings and a network
 * blip two thirds of the way through should not mean starting over.
 *
 * Flags:
 *   --force            re-embed everything, ignoring what is already stored
 *   --toolkits-only    index integrations but not their tools (fast smoke test)
 *   --limit=N          stop after N toolkits (development)
 */

import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

const COMPOSIO_BASE = "https://backend.composio.dev/api/v3";
const EMBED_MODEL = "text-embedding-3-small";
/** Must match EMBED_DIMENSIONS in src/lib/ai/openai.ts and the vector(256) column. */
const EMBED_DIMENSIONS = 256;
/** Docs per embedding request. ~256 x ~175 tokens stays far inside the request cap. */
const EMBED_BATCH = 256;
/** Concurrent embedding requests. Higher trips rate limits on smaller accounts. */
const EMBED_CONCURRENCY = 4;
/** Rows per Supabase upsert. */
const UPSERT_BATCH = 500;

const args = new Set(process.argv.slice(2));
const force = args.has("--force");
const toolkitsOnly = args.has("--toolkits-only");
const limitArg = [...args].find((a) => a.startsWith("--limit="));
const toolkitLimit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;

const composioKey = process.env.COMPOSIO_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

for (const [name, value] of Object.entries({
  COMPOSIO_API_KEY: composioKey,
  OPENAI_API_KEY: openaiKey,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  SUPABASE_SERVICE_ROLE_KEY: supabaseServiceKey,
})) {
  if (!value) throw new Error(`${name} is required. Run with --env-file=.env.local`);
}

const db = createClient(supabaseUrl!, supabaseServiceKey!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const openai = new OpenAI({ apiKey: openaiKey });

interface IndexRow {
  slug: string;
  kind: "integration" | "tool";
  owner_slug: string | null;
  doc: string;
  tags: string[];
  embedding?: number[];
}

// ---------------------------------------------------------------------------
// Composio paging
// ---------------------------------------------------------------------------

async function composio<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${COMPOSIO_BASE}${path}`, {
        headers: { "x-api-key": composioKey! },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`Composio ${res.status} on ${path}`);
      return (await res.json()) as T;
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`Composio unreachable: ${path}`);
}

interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

async function* pages<T>(path: string): AsyncGenerator<T[]> {
  let cursor: string | null = null;
  do {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${path}${sep}limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page: Page<T> = await composio<Page<T>>(url);
    yield page.items ?? [];
    cursor = page.next_cursor ?? null;
  } while (cursor);
}

interface Toolkit {
  slug: string;
  name: string;
  meta?: { description?: string; categories?: { name?: string }[]; tools_count?: number };
}

interface Tool {
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  toolkit?: { slug?: string; name?: string };
  is_deprecated?: boolean;
}

// ---------------------------------------------------------------------------
// Documents
//
// Tool-to-Agent indexes "name + description" for both entity types. The slug
// is added for tools because it carries real signal a description sometimes
// omits (SLACK_SEND_MESSAGE), and the parent name because a tool asked about
// in isolation ("send a message") is ambiguous without knowing whose it is.
// ---------------------------------------------------------------------------

function integrationDoc(tk: Toolkit): string {
  const cats = (tk.meta?.categories ?? []).map((c) => c.name).filter(Boolean).join(", ");
  return [tk.name, tk.meta?.description ?? "", cats && `Categories: ${cats}`]
    .filter(Boolean)
    .join(" — ");
}

function toolDoc(tool: Tool, toolkitName: string): string {
  return [
    `${tool.name} (${toolkitName})`,
    tool.slug.replace(/_/g, " ").toLowerCase(),
    tool.description ?? "",
  ]
    .filter(Boolean)
    .join(" — ");
}

// ---------------------------------------------------------------------------
// Embedding
// ---------------------------------------------------------------------------

async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await openai.embeddings.create({
        model: EMBED_MODEL,
        input: texts,
        dimensions: EMBED_DIMENSIONS,
      });
      return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (attempt === 4 || (status && status < 500 && status !== 429)) throw err;
      await sleep(2000 * 2 ** attempt);
    }
  }
  throw new Error("embedding failed");
}

/** Embed every row in place, `EMBED_CONCURRENCY` batches at a time. */
async function embedAll(rows: IndexRow[], label: string): Promise<void> {
  const batches: IndexRow[][] = [];
  for (let i = 0; i < rows.length; i += EMBED_BATCH) batches.push(rows.slice(i, i + EMBED_BATCH));

  let done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(EMBED_CONCURRENCY, batches.length) }, async () => {
      while (next < batches.length) {
        const batch = batches[next++];
        const vectors = await embedBatch(batch.map((r) => r.doc));
        batch.forEach((row, i) => {
          row.embedding = vectors[i];
        });
        done += batch.length;
        process.stdout.write(`\r  embedding ${label}: ${done}/${rows.length}   `);
      }
    }),
  );
  process.stdout.write("\n");
}

async function upsertAll(rows: IndexRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const chunk = rows.slice(i, i + UPSERT_BATCH).map((r) => ({ ...r, refreshed_at: new Date().toISOString() }));
    // Retried like the Composio and OpenAI calls above. Without this a single
    // dropped connection discards a toolkit's embeddings AFTER paying for
    // them — which is exactly what happened to `svix` and `tldv` on the first
    // full run.
    let lastError = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const { error } = await db.from("tool_index").upsert(chunk, { onConflict: "slug" });
      if (!error) {
        lastError = "";
        break;
      }
      lastError = error.message;
      await sleep(1000 * 2 ** attempt);
    }
    if (lastError) throw new Error(`upsert failed: ${lastError}`);
    process.stdout.write(`\r  upserting: ${Math.min(i + UPSERT_BATCH, rows.length)}/${rows.length}   `);
  }
  process.stdout.write("\n");
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Slugs already embedded, so a resumed run skips them. */
async function existingSlugs(): Promise<Set<string>> {
  if (force) return new Set();
  const out = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("tool_index")
      .select("slug")
      .not("embedding", "is", null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`read existing failed: ${error.message}`);
    for (const r of data ?? []) out.add((r as { slug: string }).slug);
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const skip = await existingSlugs();
  console.info(`already indexed: ${skip.size} entities${force ? " (ignored, --force)" : ""}`);

  console.info("fetching toolkits…");
  const toolkits: Toolkit[] = [];
  for await (const batch of pages<Toolkit>("/toolkits")) {
    toolkits.push(...batch);
    if (toolkits.length >= toolkitLimit) break;
  }
  const selected = toolkits.slice(0, Number.isFinite(toolkitLimit) ? toolkitLimit : undefined);
  console.info(`toolkits: ${selected.length}`);

  const integrationRows: IndexRow[] = selected
    .filter((tk) => !skip.has(tk.slug))
    .map((tk) => ({
      slug: tk.slug,
      kind: "integration" as const,
      owner_slug: null,
      doc: integrationDoc(tk),
      tags: [],
    }));

  if (integrationRows.length) {
    await embedAll(integrationRows, "integrations");
    await upsertAll(integrationRows);
  } else {
    console.info("  integrations already up to date");
  }

  if (toolkitsOnly) {
    console.info(`done in ${((Date.now() - started) / 1000).toFixed(0)}s (toolkits only)`);
    return;
  }

  // Tools, one toolkit at a time so a failure loses one toolkit's progress
  // rather than the whole run, and so memory stays bounded.
  let processed = 0;
  let indexed = 0;
  for (const tk of selected) {
    processed++;
    const rows: IndexRow[] = [];
    try {
      for await (const batch of pages<Tool>(`/tools?toolkit_slug=${encodeURIComponent(tk.slug)}`)) {
        for (const tool of batch) {
          if (tool.is_deprecated) continue;
          if (skip.has(tool.slug)) continue;
          rows.push({
            slug: tool.slug,
            kind: "tool",
            owner_slug: tk.slug,
            doc: toolDoc(tool, tk.name),
            tags: tool.tags ?? [],
          });
        }
      }
    } catch (err) {
      console.error(`\n  [${tk.slug}] fetch failed, skipping: ${(err as Error).message}`);
      continue;
    }

    if (!rows.length) continue;
    console.info(`[${processed}/${selected.length}] ${tk.slug}: ${rows.length} new tools`);
    try {
      await embedAll(rows, tk.slug);
      await upsertAll(rows);
      indexed += rows.length;
    } catch (err) {
      console.error(`  [${tk.slug}] index failed, skipping: ${(err as Error).message}`);
    }
  }

  console.info(
    `done: ${indexed} tools + ${integrationRows.length} integrations in ${((Date.now() - started) / 1000).toFixed(0)}s`,
  );
}

await main();
