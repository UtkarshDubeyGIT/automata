import { classifyPalette } from "@/lib/brand/palette";
import { runFirecrawl } from "@/lib/integrations/firecrawl";
import type { BrandKit } from "@/lib/brand";

/**
 * Reading a brand off a site our own Chromium is not allowed to load.
 *
 * Big consumer brands sit behind Akamai/Cloudflare bot walls, and those walls
 * gate on the DOCUMENT request. Playwright asks for the page and gets an
 * "Access Denied" shell: three elements, no stylesheet, default serif. Nothing
 * downstream noticed, so the shell was read AS the brand — godaddy.com scanned
 * to `colors: ["#000000"]`, `fonts: Times`, and that was persisted and fed to
 * every generator as the company's visual identity. zomato.com simply timed out
 * and produced no kit at all.
 *
 * Firecrawl is already a dependency and is already used for the text half of
 * onboarding. It proxies, so it gets the real page: 290KB of GoDaddy's actual
 * DOM, logo asset and brand teal included. This module is the visual half of
 * that same call — the one thing the scan could never get on its own.
 *
 * Why regex rather than a DOM: the fallback exists precisely because we could
 * not render the page. Firecrawl's HTML rewrites and strips stylesheet links,
 * so loading it into Chromium yields an UNSTYLED document — every computed
 * colour, font and bounding box is the browser default. Measured: stylesheets
 * 0, fonts "Times", backgrounds "#efefef". So this reads only what survives
 * without CSS — markup, attributes and declared colours — and never asks the
 * questions that need layout.
 */

/** What the live page looked like, for deciding whether to believe it. */
export interface PageVitals {
  title: string;
  bodyChars: number;
  elementCount: number;
  stylesheets: number;
}

const BLOCK_TITLE =
  /access denied|forbidden|attention required|just a moment|verify you are human|checking your browser|request blocked|are you a robot|rate limit|unavailable/i;

/**
 * True when the loaded document is a bot wall or an error shell rather than the
 * site. Deliberately conservative: a false positive only costs one extra
 * Firecrawl call, while a false negative persists a challenge page as a brand.
 */
export function looksBlocked(v: PageVitals): boolean {
  if (BLOCK_TITLE.test(v.title)) return true;
  // A real marketing page has hundreds of elements and real copy. A challenge
  // page has a heading and a reference number.
  if (v.elementCount < 40 && v.bodyChars < 600) return true;
  // Styled by nothing at all, yet claiming to be a page — the shell case.
  if (v.stylesheets === 0 && v.elementCount < 120) return true;
  return false;
}

/** Fetch the real DOM through Firecrawl's proxy. null when unavailable. */
export async function fetchSiteHtml(url: string): Promise<string | null> {
  try {
    const result = await runFirecrawl(
      { operation: "scrape", url, format: "html", onlyMainContent: false },
      { timeoutMs: 90_000 },
    );
    const html = result.kind === "result" ? String(result.data && typeof result.data === "object" && !Array.isArray(result.data) && "html" in result.data ? (result.data as { html?: unknown }).html ?? result.text ?? "" : result.text ?? "") : "";
    return html.length > 2_000 ? html : null;
  } catch {
    return null;
  }
}

/** Marks that belong to another company, or to a UI icon set. */
const THIRD_PARTY =
  /github|gitlab|twitter|linkedin|discord|facebook|instagram|youtube|tiktok|reddit|trustpilot|g2crowd|capterra|producthunt|app-?store|google-?play|visa|mastercard|amex|paypal|icon-tabler|lucide|feather-icon/i;

interface LogoCandidate {
  url: string;
  score: number;
  label: string;
}

/**
 * Pick the brand mark out of raw markup, using only signals that survive
 * without CSS: what the element calls itself, whether its link goes home, and
 * how early it appears.
 *
 * Mirrors the identity requirement the rendered-page scorer uses — a candidate
 * must name itself a logo or name the company — because the failure it prevents
 * is the same one, and here there is no geometry to fall back on.
 */
function pickLogo(html: string, base: string, brandWord: string): LogoCandidate | null {
  const abs = (u: string): string | null => {
    try {
      const s = new URL(u, base).toString();
      return /^https?:/.test(s) ? s : null;
    } catch {
      return null;
    }
  };

  // The WHOLE document, and no position weighting at all.
  //
  // Both were tried and both were wrong. Capping at the first 60KB assumed the
  // masthead comes first; GoDaddy's two real logo tags sit at byte 80,259 and
  // 288,828 of a 290KB document — 99.6% of the way in — so the cap found
  // nothing and the scan returned no logo for the one case this module exists
  // to serve. Weighting by "earlier is better" fails the same page for the same
  // reason, and inverting it would break every ordinary site.
  //
  // Document order simply does not survive server rendering and hydration
  // payloads, so it is not used. Precision comes from what the tag SAYS about
  // itself — the identity requirement and the third-party filter below — which
  // is a property of the tag, not of where a framework happened to emit it.
  const out: LogoCandidate[] = [];

  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const at = (name: string) =>
      tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? "";
    const src = at("src") || at("data-src");
    if (!src) continue;
    const raw = abs(src);
    if (!raw) continue;

    const file = src.split("?")[0].split("/").pop() ?? "";
    const text = `${at("alt")} ${at("aria-label")} ${at("title")} ${at("data-cy")} ${at("data-testid")} ${at("class")} ${file}`;
    if (THIRD_PARTY.test(text)) continue;

    const namesLogo = /logo|wordmark|brandmark/i.test(text);
    const namesBrand = brandWord.length > 2 && text.toLowerCase().includes(brandWord);
    // Same contract as the rendered scorer: no identity, no candidate.
    if (!namesLogo && !namesBrand) continue;

    let score = 0;
    if (namesLogo) score += 20;
    if (namesBrand) score += 20;

    // A site names its ONE canonical mark with a bare identifier — data-cy="logo",
    // id="logo" — and names every variant with a qualified one:
    // "gd-guides-logo", "logo-gold", "footer-logo". That distinction is the only
    // reliable way to tell a company's logo from its SUB-BRAND's logo, and the
    // sub-brand is a real failure: GoDaddy's header mark carries no width/height
    // attributes while "gd guides logo" declares 174x24, so on shape alone the
    // content sub-brand outscored the company and shipped as GoDaddy's identity.
    // Zomato fails the same way, where the transparent candidate is "Zomato GOLD".
    //
    // Marketing pages are full of qualified logo names and have exactly one bare
    // one, so this is decisive where geometry and word-matching are not.
    const exactLogoSlot = ["data-cy", "data-testid", "id", "class"].some(
      (a) => at(a).trim().toLowerCase() === "logo",
    );
    if (exactLogoSlot) score += 25;
    // Declared dimensions are the only geometry available in markup, and a
    // masthead wordmark is wide. Absent attributes score neutrally.
    const w = parseInt(at("width"), 10);
    const h = parseInt(at("height"), 10);
    if (w && h) {
      const ratio = w / h;
      if (ratio >= 1.6 && ratio <= 9) score += 12;
      if (w < 40 && h < 40) score -= 20;
    }
    // An SVG is the crisp original; ffmpeg cannot read it but we rasterize.
    if (/\.svg(\?|$)/i.test(src)) score += 4;

    out.push({ url: raw, score, label: `${at("alt") || at("data-cy") || file}`.slice(0, 90) });
  }

  out.sort((a, b) => b.score - a.score);
  return out[0] ?? null;
}

/**
 * Colours declared in the markup, ranked by how often they appear.
 *
 * Crude next to reading computed styles, and deliberately so — it runs only
 * when computed styles are unavailable. Hexes sitting near a third-party name
 * are dropped, because a Trustpilot badge or a payment-methods row would
 * otherwise contribute its own brand colour to ours.
 */
function declaredColors(html: string): string[] {
  const count = new Map<string, number>();
  for (const m of html.matchAll(/#[0-9a-fA-F]{6}\b/g)) {
    const near = html.slice(Math.max(0, m.index - 300), m.index + 300);
    if (THIRD_PARTY.test(near)) continue;
    const hex = m[0].toLowerCase();
    count.set(hex, (count.get(hex) ?? 0) + 1);
  }
  return [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([hex]) => hex);
}

function metaContent(html: string, key: string): string | null {
  const a = html.match(
    new RegExp(`<meta[^>]+(?:name|property)\\s*=\\s*["']${key}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, "i"),
  )?.[1];
  const b = html.match(
    new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:name|property)\\s*=\\s*["']${key}["']`, "i"),
  )?.[1];
  return (a || b || "").trim() || null;
}

/**
 * Build what can be known about a brand from markup alone.
 *
 * Returns no typography: font-family lives in the stylesheets Firecrawl strips,
 * and the blocked-page read was reporting the browser's default serif as the
 * brand's typeface. Omitting the field lets `brandKitSummary` stay silent about
 * type instead of telling every generator this company writes in Times.
 */
export async function brandKitFromHtml(
  html: string,
  url: string,
  prepareLogo: (assetUrl: string) => Promise<{ logoUrl: string; logoOverlayUrl?: string } | null>,
): Promise<BrandKit> {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const brandWord = host.split(".")[0] ?? "";

  const themeColor = metaContent(html, "theme-color");
  const declared = declaredColors(html);
  const palette = classifyPalette({
    // Markup gives no notion of a button, a background or a foreground — only
    // "colours this page declares". They go in as candidates and classifyPalette
    // applies the same brand-ness ranking it uses for a rendered page.
    varColors: declared,
    themeColor: themeColor && /^#[0-9a-f]{6}$/i.test(themeColor) ? themeColor.toLowerCase() : null,
  });

  const candidate = pickLogo(html, url, brandWord);
  let logoUrl: string | undefined;
  let logoOverlayUrl: string | undefined;
  if (candidate) {
    console.log(`[blocked-site] logo pick: score ${candidate.score} — ${candidate.label}`);
    const prepared = await prepareLogo(candidate.url).catch(() => null);
    if (prepared) {
      logoUrl = prepared.logoUrl;
      logoOverlayUrl = prepared.logoOverlayUrl;
    }
  } else {
    console.log(`[blocked-site] no identifiable logo in markup (${host})`);
  }

  return {
    colors: palette.colors,
    primaryColor: palette.primary,
    accentColor: palette.accent,
    themeColor: palette.primary ? themeColor?.toLowerCase() : undefined,
    logoUrl,
    logoOverlayUrl,
    logoSource: "scan",
    capturedFrom: url,
    capturedAt: new Date().toISOString(),
  };
}
