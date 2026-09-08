import path from "node:path";
import fs from "node:fs/promises";
import { launchBrowser } from "@/lib/video/capture";
import { readableOn } from "@/lib/brand/palette";
import { brandTypography, fontStack } from "@/lib/video/fonts";
import type { BrandProfile } from "@/lib/brand";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import { createOfflineRenderContext } from "@/lib/video/capture-network";

/**
 * The last beat of every clip: the real logo, the real colours, the URL and one
 * call to action — drawn by us, never by the video model.
 *
 * A generative model asked for "the logo and the website at the end" invents a
 * wordmark that is approximately right and a URL that is confidently wrong, and
 * then DoP animates the lettering so it warps as it moves. `brandVideoHint`
 * already forbids it from drawing any of that. This is the other half of that
 * bargain: the frame it refuses to draw, composited deterministically.
 *
 * Typeset in the headless Chromium already in this pipeline for the same reason
 * captions are (see captions.ts): the ffmpeg build is resolved from PATH and
 * cannot be assumed to have libass or freetype, but `overlay` and `concat` are
 * plain libavfilter and exist everywhere.
 */

/**
 * How long the card holds, in seconds.
 *
 * Taken OUT of the clip's advertised length rather than added on top — the last
 * take is trimmed to make room (see stitch.ts). A "30s" clip that delivers 31.8s
 * is the same class of error as the head-trim overstatement TAKE_LENGTHS exists
 * to correct.
 *
 * Long enough to read a URL aloud, short enough not to feel like dead air.
 */
export const ENDCARD_SECONDS = 1.8;

const RENDER_TIMEOUT_MS = 45_000;
const LOGO_FETCH_TIMEOUT_MS = 15_000;

export interface EndCardContent {
  /** Display form of the site, e.g. "zidane.ai" — never a full href. */
  url?: string;
  /** One imperative line: "Start free today". */
  cta?: string;
  company?: string;
}

/**
 * What the card should say, from the brand profile plus a CTA the script writer
 * produced. Returns null when there is nothing worth showing — an end card with
 * no URL and no CTA is a coloured rectangle, which is worse than ending on the
 * footage.
 */
export function endCardContent(
  profile: BrandProfile | null | undefined,
  cta?: string | null,
): EndCardContent | null {
  const rawSite = (profile?.website ?? "").trim();
  let url: string | undefined;
  if (rawSite) {
    try {
      const u = new URL(/^https?:\/\//i.test(rawSite) ? rawSite : `https://${rawSite}`);
      // The host is the brand; the path is a campaign detail nobody types in.
      url = u.hostname.replace(/^www\./, "");
    } catch {
      url = undefined;
    }
  }
  // A CTA the brand has DECIDED on outranks one a script model invented for
  // this clip: it is the wording they use everywhere else, and the end card is
  // the one frame where the product asks for the click.
  const line =
    (profile?.cta ?? "").trim().replace(/\s+/g, " ").slice(0, 60) ||
    (cta ?? "").trim().replace(/\s+/g, " ").slice(0, 60) ||
    undefined;
  const company = (profile?.company ?? "").trim() || undefined;

  if (!url && !line) return null;
  return { url, cta: line, company };
}

/**
 * Render the card to a PNG at exactly `width`x`height`.
 *
 * Colour choices are deliberate. The card's ground is the brand's own
 * BACKGROUND colour, not its primary: the logo was drawn to sit on that
 * background, and a transparent mark whose ink happens to be white disappears
 * on a white primary. Text is contrast-checked against the ground rather than
 * taken on trust, because a brand whose own site fails AA would otherwise ship
 * an unreadable end card.
 */
export async function renderEndCard(input: {
  width: number;
  height: number;
  profile?: BrandProfile | null;
  content: EndCardContent;
}): Promise<{ png: Buffer; fontFallback: boolean } | null> {
  const { width, height, profile, content } = input;
  const kit = profile?.brandKit;

  const ground = kit?.backgroundColor ?? "#0b0b0c";
  const ink = readableOn(ground, kit?.textColor);
  // The accent line under the CTA. Prefer a real brand colour that is legible
  // on the ground; fall back to the ink so it is never invisible.
  const primary = kit?.primaryColor ?? kit?.accentColor;
  const accent = primary && readableOn(ground, primary) === primary ? primary : ink;

  // For the END card an opaque logo is fine — unlike the corner overlay, which
  // is composited over moving footage and would show as a rectangle. Here the
  // ground is the very background the mark was designed against, so a cropped
  // screenshot or an apple-touch-icon reads correctly. Prefer the transparent
  // master when we have one, since it composites cleanly at any size.
  const transparent = !!kit?.logoOverlayUrl;
  const logoUrl = kit?.logoOverlayUrl ?? kit?.logoUrl;
  const logoData = logoUrl ? await fetchAsDataUri(logoUrl) : null;

  const browser = await launchBrowser().catch(() => null);
  if (!browser) {
    console.error("[video/endcard] no browser to typeset with");
    return null;
  }
  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    context = await createOfflineRenderContext(browser, {
      viewport: { width, height },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    // The customer's OWN typeface, fetched and embedded — not merely named.
    // Naming a family the render host does not have is what silently produced
    // Helvetica end cards for every brand (see lib/video/fonts).
    const type = await brandTypography(kit);
    const stack = fontStack(type.headingFamily ?? type.bodyFamily, !type.fallback);

    // Sized off the SHORT edge so a 16:9 card and a 9:16 card read the same.
    const unit = Math.min(width, height);
    const ctaSize = Math.round(unit * 0.082);
    const urlSize = Math.round(unit * 0.05);
    const logoWidth = Math.round(unit * 0.34);

    const esc = (s: string) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>` +
        type.css +
        `html,body{margin:0;padding:0;width:${width}px;height:${height}px;background:${ground}}` +
        `#card{width:${width}px;height:${height}px;display:flex;flex-direction:column;` +
        `align-items:center;justify-content:center;gap:${Math.round(unit * 0.045)}px;` +
        `font-family:${stack};color:${ink};text-align:center;padding:0 8%;box-sizing:border-box}` +
        // A transparent mark sits directly on the card. An OPAQUE one — an
        // apple-touch-icon, a cropped screenshot — carries its own background
        // with it, and dropping that straight onto a contrasting ground reads
        // as a stray rectangle. Rounding it into a tile is how that asset is
        // designed to be seen everywhere else, so it reads as deliberate.
        (transparent
          ? `#logo{width:${logoWidth}px;height:auto;max-height:${Math.round(unit * 0.22)}px;object-fit:contain}`
          : `#logo{width:${Math.round(unit * 0.2)}px;height:${Math.round(unit * 0.2)}px;` +
            `object-fit:cover;border-radius:22.5%;` +
            `box-shadow:0 ${Math.round(unit * 0.008)}px ${Math.round(unit * 0.02)}px rgba(0,0,0,.18)}`) +
        `#cta{font-size:${ctaSize}px;font-weight:800;line-height:1.15;letter-spacing:-0.01em}` +
        `#rule{width:${Math.round(unit * 0.12)}px;height:${Math.max(3, Math.round(unit * 0.008))}px;` +
        `background:${accent};border-radius:999px}` +
        `#url{font-size:${urlSize}px;font-weight:600;color:${accent};letter-spacing:0.01em}` +
        `</style><div id="card">` +
        (logoData ? `<img id="logo" src="${logoData}">` : "") +
        (content.cta ? `<div id="cta">${esc(content.cta)}</div>` : "") +
        (content.cta && content.url ? `<div id="rule"></div>` : "") +
        (content.url ? `<div id="url">${esc(content.url)}</div>` : "") +
        `</div>`,
    );

    // Give a webfont-less render a moment to settle; the fonts are local stacks
    // so this is about layout, not network.
    await page.waitForTimeout(150);
    const shot = await Promise.race([
      page.locator("#card").screenshot({ type: "png" }),
      new Promise<null>((r) => setTimeout(() => r(null), RENDER_TIMEOUT_MS)),
    ]);
    return shot && shot.length > 200 ? { png: shot, fontFallback: type.fallback } : null;
  } catch (err) {
    console.error("[video/endcard] render failed:", err);
    return null;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Inline a remote image so the page never makes a network request. */
async function fetchAsDataUri(url: string): Promise<string | null> {
  if (!/^https?:/.test(url)) return null;
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!type.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Render the card and write it next to the clip being assembled. Returns the
 * file path, or null when there is nothing to draw or drawing failed — both of
 * which mean "ship the clip without an end card", never "fail the render".
 */
export async function writeEndCardImage(input: {
  dir: string;
  width: number;
  height: number;
  profile?: BrandProfile | null;
  cta?: string | null;
}): Promise<{ file: string; fontFallback: boolean } | null> {
  const content = endCardContent(input.profile, input.cta);
  if (!content) return null;
  const out = await renderEndCard({
    width: input.width,
    height: input.height,
    profile: input.profile,
    content,
  });
  if (!out) return null;
  const file = path.join(input.dir, "endcard.png");
  await fs.writeFile(file, out.png);
  return { file, fontFallback: out.fontFallback };
}
