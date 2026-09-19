-- Search over the tool index, rolled up to owning integrations.
--
-- Ranking, fusion and roll-up live in one function so retrieval is a single
-- round trip during a workflow build, and so both halves are guaranteed to
-- come from the same snapshot of the table.
--
-- THE DEFAULT MODE IS LEXICAL, and that is a measured result, not a shortcut.
-- The table carries embeddings and the dense half works; it simply loses.
-- Scored on tests/fixtures/retrieval-cases.ts against the full 31k-entity
-- index (recall@20, retrieval only):
--
--     lexical  79.3%   vocabulary 72.7%   multi 100%   484ms
--     hybrid   69.0%   vocabulary 54.5%   multi  87.5% 812ms
--     dense    37.9%   vocabulary 27.3%   multi  25%   699ms
--
-- Dense loses even on `vocabulary` — requests that name no app at all, which
-- is the case semantic search exists for. This matches ToolRet
-- (arXiv 2503.01763), which found general-purpose embedding models transfer
-- poorly to tool retrieval and BM25 competitive with or ahead of them. The
-- dense path is kept so scripts/eval-retrieval.ts can re-run this comparison
-- when the corpus changes; it is not on the build path.
--
-- `norm = 1` DIVIDES ts_rank BY log(document length), and it is the single
-- largest tuning win here: 62.1% -> 79.3%. Postgres does not normalise by
-- length by default, so a 3,500-character tool description matching several
-- common words ("create", "team", "add") outranked the short Airtable
-- integration doc matching the literal word "Airtable" — the request named
-- the app outright and the app still did not make the top 20.
--
-- THE LEXICAL QUERY IS OR-ED, NOT AND-ED. `websearch_to_tsquery` and
-- `plainto_tsquery` combine every lexeme with AND, which is a boolean filter
-- rather than a ranking function. Measured: that returned ZERO results for
-- all 29 fixture expectations, because no single document contains every word
-- of a sentence. Re-lexing the query and joining with `|` restores ranking
-- behaviour, and going through to_tsvector (rather than concatenating raw
-- words) normalises the query with the same dictionary as the documents and
-- stops user text carrying tsquery operators in.
--
-- FUSION IS RECIPROCAL RANK FUSION, not a weighted score blend. Cosine
-- distance and ts_rank are not on comparable scales, so any fixed weighting
-- is a constant that happens to suit the queries it was tuned on. k = 60 is
-- the constant from the original RRF paper and is not tuned here.
--
-- ROLL-UP IS max(score) PER OWNER — Algorithm 1 of Tool-to-Agent Retrieval
-- (arXiv 2511.01854) expressed as a grouping. Walking a fixed-size window in
-- application code looked equivalent and was not: GitHub alone owns ~781
-- indexed tools, so a 400-entity window collapsed to 8 distinct integrations
-- and dropped apps the request had named. Grouping lets one well-matched tool
-- carry its integration in no matter how many neighbours outrank it.

create or replace function public.tool_index_search(
  query_embedding extensions.vector(256),
  query_text text,
  match_count int default 1500,
  top_k int default 20,
  mode text default 'lexical',
  norm int default 1
)
returns table (slug text, score double precision)
language sql
stable
set search_path = public, extensions
as $$
  with q as (
    -- NULL when the query lexes to nothing; `doc_tsv @@ NULL` is NULL, so the
    -- lexical half contributes no rows rather than erroring.
    select nullif(
             array_to_string(tsvector_to_array(to_tsvector('english', query_text)), ' | '),
             ''
           )::tsquery as query
  ),
  dense as (
    select t.slug, row_number() over (order by t.embedding <=> query_embedding) as rank
    from public.tool_index t
    where mode in ('hybrid', 'dense')
      and query_embedding is not null
      and t.embedding is not null
    order by t.embedding <=> query_embedding
    limit match_count
  ),
  lexical as (
    select t.slug,
           row_number() over (order by ts_rank(t.doc_tsv, q.query, norm) desc, t.slug) as rank
    from public.tool_index t, q
    where mode in ('hybrid', 'lexical')
      and q.query is not null
      and t.doc_tsv @@ q.query
    order by ts_rank(t.doc_tsv, q.query, norm) desc, t.slug
    limit match_count
  ),
  fused as (
    select coalesce(d.slug, l.slug) as slug,
           coalesce(1.0 / (60 + d.rank), 0) + coalesce(1.0 / (60 + l.rank), 0) as score
    from dense d full outer join lexical l on d.slug = l.slug
  ),
  rolled as (
    -- An integration row owns itself; a tool row resolves to its toolkit. A
    -- tool whose owner vanished between ingestion pages falls back to its own
    -- slug rather than being silently dropped.
    select coalesce(t.owner_slug, t.slug) as integration, max(f.score) as score
    from fused f join public.tool_index t on t.slug = f.slug
    group by 1
  )
  select r.integration, r.score::double precision
  from rolled r
  order by r.score desc, r.integration
  limit top_k;
$$;

-- The browser has no business ranking the tool catalog; retrieval runs
-- server-side during a build, under the service role.
revoke all on function public.tool_index_search(extensions.vector(256), text, int, int, text, int) from public, anon, authenticated;
