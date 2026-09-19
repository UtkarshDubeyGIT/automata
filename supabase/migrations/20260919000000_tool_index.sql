-- Semantic retrieval index over Composio's full catalog.
--
-- The workflow builder used to be shown a hard-coded catalog of 999 curated
-- tools across 17 integrations, on every build call. That is both far too
-- much text (a ~73K-token prompt) and far too little coverage (Composio
-- carries 1,553 integrations and 29,921 tools). This table is the corpus a
-- retriever ranks so the builder sees ~20 relevant integrations instead.
--
-- WHY INTEGRATIONS AND TOOLS SHARE ONE TABLE. This is the Tool-to-Agent
-- Retrieval design (arXiv 2511.01854), which measured the obvious
-- alternative — rank integrations by their own descriptions, then drill into
-- the winner — and found it materially worse (recall@5 0.70-0.74 vs 0.83) on
-- exactly this topology. A coarse integration blurb is a lossy filter applied
-- before any tool-level signal is seen: "file a ticket for every crash
-- report" matches a Linear TOOL, while Linear's own one-line description
-- never mentions tickets or crashes. So both entity types are embedded into
-- one shared space and compete in a single ranking; a matching tool is then
-- rolled up to its owner via `owner_slug`. The integration rows stay in the
-- index because some queries genuinely are about the app as a whole.
--
-- NOT WORKSPACE-SCOPED. This is a cache of a public third-party catalog, the
-- same for every workspace, so there is no tenant column and nothing here is
-- customer data. RLS is enabled with no policies, which denies anon and
-- authenticated outright; the service role bypasses RLS and is the only
-- reader. The browser never queries this — retrieval happens server-side
-- during a build.

create extension if not exists vector with schema extensions;

create table if not exists public.tool_index (
  slug text primary key,
  kind text not null check (kind in ('integration', 'tool')),

  -- For a tool, the integration that owns it; null for an integration row.
  -- Deliberately NOT a foreign key: ingestion pages tools per toolkit and a
  -- toolkit can appear or vanish between pages, and a dangling owner should
  -- degrade to "skip this candidate" (the retriever already handles a missing
  -- owner) rather than abort a 30k-row upsert.
  owner_slug text,

  -- The text that gets embedded and lexically indexed.
  doc text not null,

  -- Composio ships MCP-standard annotations here: readOnlyHint,
  -- destructiveHint, openWorldHint, idempotentHint, updateHint. These are
  -- what let an uncurated tool be classified read vs write without a human
  -- reviewing 30k entries — see deriveToolSpec in composio.ts.
  tags text[] not null default '{}',

  -- 256 dims, not the model's native 1536: text-embedding-3-small is a
  -- Matryoshka model, so a truncated prefix is still a usable embedding, and
  -- 256 keeps the whole index at ~32MB instead of ~190MB.
  embedding extensions.vector(256),

  refreshed_at timestamptz not null default now()
);

create index if not exists tool_index_owner_idx
  on public.tool_index (owner_slug)
  where owner_slug is not null;

-- Lexical half of the hybrid. Generated rather than maintained by the writer,
-- so a future ingestion path cannot forget to update it.
alter table public.tool_index
  add column if not exists doc_tsv tsvector
  generated always as (to_tsvector('english', doc)) stored;

create index if not exists tool_index_tsv_idx
  on public.tool_index using gin (doc_tsv);

-- HNSW over cosine distance. Built after the first bulk load would be faster,
-- but correctness first: an index that exists from the start cannot be
-- forgotten, and 31k rows builds in seconds either way.
create index if not exists tool_index_embedding_idx
  on public.tool_index using hnsw (embedding extensions.vector_cosine_ops);

alter table public.tool_index enable row level security;
