import { composioProxy, connectedAccountId } from "./composio-proxy";
import { assertPublicUrl } from "@/lib/net/public-url";
import type { PostMedia, PostMediaAttachment } from "./post-media";

/**
 * Publishing a video to YouTube.
 *
 * WHY THIS IS NOT ONE TOOL CALL. Composio's YouTube toolkit does expose
 * `YOUTUBE_UPLOAD_VIDEO`, but its required argument is `videoFilePath` — a
 * path on the caller's own disk. Our videos are rendered by Higgsfield and
 * live at a URL, and a serverless request has nowhere to put a gigabyte of
 * MP4 even if it wanted to. The newer `YOUTUBE_MULTIPART_UPLOAD_VIDEO` wants a
 * pre-staged object key instead, which means uploading the file to Composio
 * first: the same bytes over the wire twice.
 *
 * So this drives YouTube's RESUMABLE upload protocol over the proxy, which is
 * the same shape `linkedin-media.ts` already uses for LinkedIn assets:
 *
 *   1. POST the metadata → Google answers with a one-shot upload URL in the
 *      `Location` header.
 *   2. PUT the bytes to that URL. Composio streams them straight from the
 *      source URL (`binary_body`), so the video never passes through us.
 *
 * The connection's `youtube.upload` scope is what authorises both.
 */

export class YouTubeUploadError extends Error {}

const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

/**
 * "People & Blogs" — YouTube REJECTS an upload with no category, and there is
 * no neutral one. This is the least wrong default for marketing content, and
 * the owner can recategorise in YouTube Studio afterwards.
 */
const DEFAULT_CATEGORY = "22";

/** YouTube truncates past 100 characters and rejects angle brackets outright. */
export function youtubeTitle(text: string, explicit?: string): string {
  const source = (explicit ?? text).trim();
  // First line only: a caption's opening line is the headline, and folding a
  // whole paragraph into the title field produces an unreadable one.
  const firstLine = source.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const cleaned = (firstLine || "New video").replace(/[<>]/g, "");
  return cleaned.length > 100 ? `${cleaned.slice(0, 97)}...` : cleaned;
}

/** The single video in whatever shape the caller attached it. */
export function videoUrlOf(
  media: PostMediaAttachment | undefined,
  mediaUrl: string | undefined,
): string | null {
  const list: PostMedia[] = Array.isArray(media) ? media : media ? [media] : [];
  const video = list.find((m) => m.kind === "video");
  if (video?.url) return video.url;
  // `mediaUrl` predates the typed attachment and carries no kind, so it is
  // trusted only when nothing better was supplied.
  return mediaUrl?.trim() || null;
}

export interface YouTubeUploadInput {
  entityId: string;
  /** Becomes the description; its first line becomes the title. */
  text: string;
  videoUrl: string;
  title?: string;
  /**
   * Defaults to `public`, because a scheduled "publish to YouTube" that
   * quietly lands as a private video is a silent failure — the run succeeds,
   * the post exists, and nobody can see it.
   *
   * Worth knowing: Google independently forces every upload from an UNAUDITED
   * API client to private, whatever is sent here. That is a property of the
   * OAuth app, not of this argument, and it cannot be detected from the
   * response — the video simply comes back private.
   */
  privacyStatus?: "public" | "unlisted" | "private";
  categoryId?: string;
  tags?: string[];
}

export async function uploadToYouTube(
  input: YouTubeUploadInput,
): Promise<{ videoId: string; url: string }> {
  const safeUrl = await assertPublicUrl(input.videoUrl);
  if (!safeUrl) {
    throw new YouTubeUploadError("The video must be at a resolvable public URL.");
  }

  const accountId = await connectedAccountId(input.entityId, "youtube");
  if (!accountId) {
    throw new YouTubeUploadError("YouTube isn't connected — connect it on the Integrations page.");
  }

  // 1. Open a resumable session. `part` lists the objects being sent, and
  // omitting `status` here silently discards privacyStatus.
  const init = await composioProxy<unknown>({
    connectedAccountId: accountId,
    endpoint: `${UPLOAD}?uploadType=resumable&part=snippet,status`,
    method: "POST",
    parameters: [
      // Google uses these to size the session up front. Without the type
      // header it assumes a default and can reject the bytes that follow.
      { name: "X-Upload-Content-Type", value: "video/*", type: "header" },
    ],
    body: {
      snippet: {
        title: youtubeTitle(input.text, input.title),
        description: input.text.slice(0, 5000),
        tags: input.tags?.slice(0, 30) ?? [],
        categoryId: input.categoryId ?? DEFAULT_CATEGORY,
      },
      status: {
        privacyStatus: input.privacyStatus ?? "public",
        // Required since 2020: an upload that declines to answer is rejected.
        // False is the honest answer for business marketing content, and
        // saying so keeps comments and personalisation working on the video.
        selfDeclaredMadeForKids: false,
      },
    },
  });

  if (init.status < 200 || init.status >= 300) {
    throw new YouTubeUploadError(`YouTube rejected the upload request (${init.status}).`);
  }

  // Header casing is not guaranteed across hops, so look for both.
  const headers = init.headers ?? {};
  const location =
    headers["location"] ?? headers["Location"] ?? headers["x-guploader-uploadid-location"];
  if (!location) {
    throw new YouTubeUploadError("YouTube did not return an upload URL.");
  }

  // 2. Stream the bytes. Composio fetches `url` server-side, so a large render
  // never travels through this process.
  const upload = await composioProxy<{ id?: string }>({
    connectedAccountId: accountId,
    endpoint: location,
    method: "PUT",
    binaryBody: { url: safeUrl, content_type: "video/mp4" },
  });

  if (upload.status < 200 || upload.status >= 300) {
    throw new YouTubeUploadError(`YouTube upload failed (${upload.status}).`);
  }
  const videoId = upload.data?.id;
  if (!videoId) {
    // The bytes may well have landed — a resumable session that returns 2xx
    // has accepted them — so this must not be retried blindly by the caller.
    throw new YouTubeUploadError("YouTube accepted the video but returned no id.");
  }

  return { videoId, url: `https://www.youtube.com/watch?v=${videoId}` };
}
