import { NextResponse, type NextRequest } from "next/server";
import { listToolkits, type CatalogPage } from "@/lib/social/composio";

/**
 * Browse the Composio toolkit catalog (~1000 apps). Results come back in
 * Composio's popularity order. Cached in-process for an hour per query —
 * the catalog barely changes and this keeps browsing snappy.
 */

const TTL_MS = 60 * 60 * 1000;
const MAX_ENTRIES = 200;
const cache = new Map<string, { at: number; page: CatalogPage }>();

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const search = params.get("search")?.trim().slice(0, 80) ?? "";
  const category = params.get("category") ?? "all";
  const cursor = params.get("cursor") ?? "";

  const key = `${category}|${search}|${cursor}`;
  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.page);
    cache.delete(key);
  }

  try {
    const page = await listToolkits({
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
