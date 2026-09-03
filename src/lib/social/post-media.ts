/**
 * Client-safe post media vocabulary shared by the Scheduler, workflow editor,
 * and server-side publishers. Provider calls belong elsewhere.
 */

export type PostMediaKind = "image" | "video" | "document";

export interface PostMedia {
  kind: PostMediaKind;
  /** Public asset URL. A server-side SSRF guard re-validates it before fetch. */
  url: string;
  altText?: string;
  title?: string;
  thumbnailUrl?: string;
}

export type PostMediaAttachment = PostMedia | PostMedia[];

/** Normalize the workflow editor's newline-separated LinkedIn gallery field. */
export function normalizePostMediaList(raw: string): PostMedia[] {
  const urls = raw.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (urls.length < 2) throw new Error("LinkedIn multi-image posts need at least 2 images.");
  if (urls.length > 20) throw new Error("LinkedIn multi-image posts support at most 20 images.");
  return urls.map((url) => ({ kind: "image", url }));
}

export type WebsiteLinkStyle = "none" | "soft" | "direct";

export interface WebsiteLink {
  url: string;
  style?: WebsiteLinkStyle;
  /** Optional human-written phrase, for example “I wrote up the details”. */
  label?: string;
}

export interface StoredPostExtras {
  media?: PostMedia;
  link?: WebsiteLink;
  options?: Record<string, string>;
}

const LINKEDIN_COMMENTARY_LIMIT = 3_000;

function optionalText(value: unknown): string | undefined {
  const text = typeof value === "string" ? value.trim() : "";
  return text || undefined;
}

export function inferPostMediaKind(rawUrl: string): PostMediaKind | null {
  let pathname = "";
  try {
    pathname = new URL(rawUrl).pathname.toLowerCase();
  } catch {
    pathname = rawUrl.toLowerCase().split(/[?#]/, 1)[0];
  }
  if (/\.(?:jpe?g|png|gif|webp|avif)$/.test(pathname)) return "image";
  if (/\.(?:mp4|mov|m4v|webm)$/.test(pathname)) return "video";
  if (/\.pdf$/.test(pathname)) return "document";
  return null;
}

export function normalizePostMedia(input?: {
  url?: string | null;
  kind?: PostMediaKind | "auto" | null;
  altText?: string | null;
  title?: string | null;
  thumbnailUrl?: string | null;
}): PostMedia | undefined {
  const url = optionalText(input?.url);
  if (!url) return undefined;
  const kind = input?.kind && input.kind !== "auto" ? input.kind : inferPostMediaKind(url);
  if (!kind) {
    throw new Error("Choose whether the media is an image, video, or document before publishing.");
  }
  return {
    url,
    kind,
    ...(optionalText(input?.altText) ? { altText: optionalText(input?.altText) } : {}),
    ...(optionalText(input?.title) ? { title: optionalText(input?.title) } : {}),
    ...(optionalText(input?.thumbnailUrl)
      ? { thumbnailUrl: optionalText(input?.thumbnailUrl) }
      : {}),
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Recover typed publishing metadata from Supabase jsonb without trusting it. */
export function normalizeStoredPostExtras(row: {
  media?: unknown;
  link?: unknown;
  options?: unknown;
}): StoredPostExtras {
  const out: StoredPostExtras = {};
  const rawMedia = object(row.media);
  if (rawMedia) {
    try {
      if (["image", "video", "document"].includes(String(rawMedia.kind))) {
        out.media = normalizePostMedia({
          url: typeof rawMedia.url === "string" ? rawMedia.url : undefined,
          kind: rawMedia.kind as PostMediaKind,
          altText: typeof rawMedia.altText === "string" ? rawMedia.altText : undefined,
          title: typeof rawMedia.title === "string" ? rawMedia.title : undefined,
          thumbnailUrl:
            typeof rawMedia.thumbnailUrl === "string" ? rawMedia.thumbnailUrl : undefined,
        });
      }
    } catch {
      // Old or hand-edited rows fall back to a text post instead of failing a sweep.
    }
  }

  const rawLink = object(row.link);
  if (
    rawLink &&
    typeof rawLink.url === "string" &&
    (!rawLink.style || ["none", "soft", "direct"].includes(String(rawLink.style)))
  ) {
    out.link = {
      url: rawLink.url,
      style: (rawLink.style as WebsiteLinkStyle | undefined) ?? "soft",
      ...(typeof rawLink.label === "string" && rawLink.label.trim()
        ? { label: rawLink.label.trim() }
        : {}),
    };
  }

  const rawOptions = object(row.options);
  if (rawOptions) {
    const options = Object.fromEntries(
      Object.entries(rawOptions).filter((entry): entry is [string, string] =>
        typeof entry[1] === "string"),
    );
    if (Object.keys(options).length) out.options = options;
  }
  return out;
}

function canonicalUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function captionAlreadyLinksTo(caption: string, target: string): boolean {
  const urls = caption.match(/https?:\/\/[^\s<>()]+/gi) ?? [];
  return urls.some((url) => canonicalUrl(url.replace(/[.,;!?]+$/, "")) === target);
}

/**
 * Add an optional website mention without turning every post into an ad.
 * The soft treatment is deliberately factual and low-pressure; a custom label
 * lets AI-generated or hand-written copy keep the author's own voice.
 */
export function captionWithWebsiteLink(caption: string, link?: WebsiteLink): string {
  if (!link || (link.style ?? "soft") === "none" || !link.url.trim()) return caption;

  const target = canonicalUrl(link.url.trim());
  if (!target) throw new Error("Website link must be a valid http or https URL.");
  if (captionAlreadyLinksTo(caption, target)) return caption;

  const customLabel = optionalText(link.label)?.replace(/\s+/g, " ").replace(/:+$/, "");
  const label = customLabel ?? ((link.style ?? "soft") === "direct" ? "Learn more" : "More context");
  const suffix = `\n\n${label}: ${link.url.trim()}`;
  const available = LINKEDIN_COMMENTARY_LIMIT - suffix.length;
  if (available <= 0) throw new Error("Website link is too long for a LinkedIn post.");

  let body = caption.trimEnd();
  if (body.length > available) {
    body = `${body.slice(0, Math.max(0, available - 1)).trimEnd()}…`;
  }
  return `${body}${suffix}`;
}
