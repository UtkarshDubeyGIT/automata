import { createAdminClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { fetchPublicUrl } from "@/lib/net/public-fetch";

/**
 * Copy a completed video (and its thumbnail) from the provider's CDN into our
 * own Supabase Storage, so history never depends on provider URL lifetimes.
 *
 * Idempotent: rows whose url already points at our storage are left alone.
 * Uses the service-role client — this runs server-side only.
 */
export async function archiveVideoRow(jobId: string): Promise<string | null> {
  const db = createAdminClient();
  const { data: row } = await db
    .from("videos")
    .select("id, workspace_id, url, thumbnail_url")
    .eq("job_id", jobId)
    .maybeSingle();
  if (!row?.url) return null;

  // Already ours? Nothing to do.
  if (row.url.startsWith(env.supabaseUrl)) return row.url;

  const videoPath = `${row.workspace_id}/${jobId}.mp4`;
  const archivedUrl = await copyToStorage(row.url, videoPath, "video/mp4");
  if (!archivedUrl) return null;

  let archivedThumb: string | null = null;
  if (row.thumbnail_url && !row.thumbnail_url.startsWith(env.supabaseUrl)) {
    archivedThumb = await copyToStorage(
      row.thumbnail_url,
      `${row.workspace_id}/${jobId}-thumb.png`,
      "image/png",
    );
  }

  await db
    .from("videos")
    .update({
      url: archivedUrl,
      ...(archivedThumb ? { thumbnail_url: archivedThumb } : {}),
    })
    .eq("id", row.id);

  return archivedUrl;
}

async function copyToStorage(
  sourceUrl: string,
  path: string,
  fallbackType: string,
): Promise<string | null> {
  try {
    const res = await fetchPublicUrl(sourceUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const db = createAdminClient();
    const { error } = await db.storage.from("videos").upload(path, buf, {
      contentType: res.headers.get("content-type") ?? fallbackType,
      upsert: true,
    });
    if (error) {
      console.error("[video/archive] upload failed:", error.message);
      return null;
    }
    const { data } = db.storage.from("videos").getPublicUrl(path);
    return data.publicUrl;
  } catch (err) {
    console.error("[video/archive] copy failed:", err);
    return null;
  }
}
