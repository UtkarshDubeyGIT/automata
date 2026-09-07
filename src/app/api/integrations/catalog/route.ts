import { NextResponse, type NextRequest } from "next/server";
import { listToolkits, listToolkitsBySlug, type CatalogPage } from "@/lib/social/composio";

/**
 * Browse the Composio toolkit catalog (~1000 apps). Results come back in
 * Composio's popularity order. Cached in-process for an hour per query —
 * the catalog barely changes and this keeps browsing snappy.
 *
 * `?slugs=a,b` fetches named toolkits instead of a page, which is how the
 * grid gets a card for a connected app that ranks below the first page.
 * Everything here describes the catalog, never a workspace, so one process-wide
 * cache is safe: the caller decides which slugs to ask for, and the answer for
 * a given slug is the same for everyone.
 */

/** Enough for any workspace's connected apps; a cap keeps the fan-out bounded. */
const MAX_SLUGS = 24;

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; page: CatalogPage }>();

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const search = params.get("search")?.trim().slice(0, 80) ?? "";
  const category = params.get("category") ?? "all";
  const cursor = params.get("cursor") ?? "";
  const slugs = (params.get("slugs") ?? "")
    .split(",")
    .map((slug) => slug.trim().toLowerCase())
    .filter((slug) => /^[a-z0-9_-]{1,60}$/.test(slug))
    .slice(0, MAX_SLUGS)
    .sort();

  const key = slugs.length ? `slugs|${slugs.join(",")}` : `${category}|${search}|${cursor}`;
  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.page);
    cache.delete(key);
  }

  try {
    const page: CatalogPage = slugs.length
      ? await listToolkitsBySlug(slugs).then((items) => ({
          items,
          nextCursor: null,
          total: items.length,
        }))
      : await listToolkits({
          search: search || undefined,
          category,
          cursor: cursor || undefined,
        });
    // Bounded cache: evict the oldest entry (Maps iterate in insertion order).
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: Date.now(), page });
    return NextResponse.json(page);
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, items: [], nextCursor: null, total: 0 },
      { status: 502 },
    );
  }
}
