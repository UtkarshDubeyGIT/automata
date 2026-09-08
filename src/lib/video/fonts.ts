import type { BrandKit } from "@/lib/brand";
import { fetchPublicUrl } from "@/lib/net/public-fetch";

/**
 * Typography that is actually the customer's.
 *
 * The brand scan reads a font NAME off the rendered site — "Pixel Hackers",
 * "Sora" — and until now that name went straight into a CSS stack on the render
 * host. Render hosts have no brand fonts installed, so every one of those
 * stacks fell through to Helvetica, and the "brand typography" on an end card
 * was whatever the machine happened to have. Silently: the fallback chain is
 * doing exactly what it was written to do, so nothing looks broken.
 *
 * The fix is not to bundle one customer's font with the product. That solves it
 * for a single brand and for nobody else, and it puts a licensed file in our
 * repository. Instead the scan records WHERE the font came from, and the
 * renderer fetches that file and inlines it — so the typography is per
 * workspace, and a workspace we could not resolve a font for is recorded as
 * such rather than quietly downgraded.
 *
 * What may be loaded is deliberately narrow. See `isAuthorisedFontSource`.
 */

/**
 * Font hosts we are willing to fetch from.
 *
 * - The customer's OWN origin. A self-hosted file is the customer's to use, and
 *   rendering their video with it is them using it.
 * - Google Fonts' file host, which serves open-licensed families.
 *
 * Everything else is excluded, and the exclusions are the point: Adobe Fonts
 * (use.typekit.net) and Monotype (fast.fonts.net) license per-domain for web
 * display, and neither that licence nor ours covers embedding the glyphs into a
 * video file we hand back. A missing font is a cosmetic downgrade; shipping a
 * customer an asset that infringes their foundry licence is not.
 */
const GOOGLE_FONT_HOST = "fonts.gstatic.com";

export function isAuthorisedFontSource(fontUrl: string, siteUrl: string): boolean {
  try {
    const font = new URL(fontUrl);
    if (font.protocol !== "https:") return false;
    if (font.hostname === GOOGLE_FONT_HOST) return true;
    const site = new URL(siteUrl);
    // Same registrable site, allowing the usual www / bare-domain split.
    const strip = (h: string) => h.replace(/^www\./, "").toLowerCase();
    return strip(font.hostname) === strip(site.hostname);
  } catch {
    return false;
  }
}

/** Reduce a family name or filename to comparable letters. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Pick the font file that belongs to `family` out of everything the page
 * loaded.
 *
 * Matched on the filename rather than by parsing stylesheets, because the
 * @font-face rules that would name it authoritatively live in cross-origin
 * sheets whose `cssRules` the browser refuses to expose. Build tools hash
 * filenames but keep the family in them ("pixel-hackers.DRgDV23i.woff2"), so
 * the slug survives. woff2 is preferred — every browser we rasterise with
 * supports it, and it is the smallest to inline.
 */
export function pickFontFile(family: string | undefined, urls: string[]): string | undefined {
  const want = slug(family ?? "");
  if (!want || want.length < 4) return undefined;
  const named = urls.filter((u) => {
    const file = slug(u.split("?")[0].split("/").pop() ?? "");
    return file.includes(want);
  });
  if (named.length === 0) return undefined;
  return (
    named.find((u) => /\.woff2(\?|$)/i.test(u)) ??
    named.find((u) => /\.woff(\?|$)/i.test(u)) ??
    named[0]
  );
}

/** CSS `format()` token for a font URL. */
function formatOf(url: string): string {
  if (/\.woff2(\?|$)/i.test(url)) return "woff2";
  if (/\.woff(\?|$)/i.test(url)) return "woff";
  if (/\.otf(\?|$)/i.test(url)) return "opentype";
  return "truetype";
}

const FONT_FETCH_TIMEOUT_MS = 15_000;
/** A brand font is tens of kilobytes; anything past this is not one. */
const MAX_FONT_BYTES = 4_000_000;

async function inlineFont(url: string): Promise<string | null> {
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(FONT_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500 || buf.length > MAX_FONT_BYTES) return null;
    return `url(data:font/${formatOf(url)};base64,${buf.toString("base64")}) format("${formatOf(url)}")`;
  } catch {
    return null;
  }
}

export interface BrandTypography {
  /** `@font-face` blocks to inject, or "" when none could be loaded. */
  css: string;
  /** The family name to lead the CSS stack with. */
  headingFamily?: string;
  bodyFamily?: string;
  /**
   * TRUE when the real brand font could not be embedded and the render fell
   * back to a generic face. Recorded on the row so "our font looks wrong" is
   * answerable from the data instead of by eye.
   */
  fallback: boolean;
}

/**
 * Resolve the workspace's typography into embeddable CSS.
 *
 * Never throws and never blocks a render: a font that will not load leaves
 * `fallback: true` and the caller's own stack takes over.
 */
export async function brandTypography(kit: BrandKit | null | undefined): Promise<BrandTypography> {
  const heading = kit?.headingFont;
  const body = kit?.bodyFont;
  const faces: string[] = [];

  // The same family for heading and body is the common case; load it once.
  const wanted: Array<{ family?: string; url?: string }> = [
    { family: heading, url: kit?.headingFontUrl },
    { family: body, url: kit?.bodyFontUrl },
  ];

  const loaded = new Set<string>();
  for (const w of wanted) {
    if (!w.family || !w.url || loaded.has(w.family)) continue;
    const src = await inlineFont(w.url);
    if (!src) continue;
    loaded.add(w.family);
    faces.push(
      `@font-face{font-family:${JSON.stringify(w.family)};src:${src};font-display:block;}`,
    );
  }

  return {
    css: faces.join(""),
    headingFamily: heading && loaded.has(heading) ? heading : undefined,
    bodyFamily: body && loaded.has(body) ? body : undefined,
    // Fallback whenever we have a name but could not embed the file — including
    // the case where no font was discovered at all.
    fallback: faces.length === 0,
  };
}

/**
 * The CSS font stack to render with.
 *
 * The requested family leads ONLY when its file was actually embedded. Naming
 * an unavailable family first is what produced the silent downgrade this module
 * exists to fix — the browser skips it without complaint and nothing records
 * that the brand's typography was not used.
 */
export function fontStack(family: string | undefined, embedded: boolean): string {
  const generic = [
    '"Helvetica Neue"',
    "Helvetica",
    "Arial",
    '"Liberation Sans"',
    "sans-serif",
  ];
  return (embedded && family ? [JSON.stringify(family), ...generic] : generic).join(", ");
}
