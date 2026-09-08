import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { chromium, type Page, type Browser, type LaunchOptions } from "playwright";
import { createAdminClient } from "@/lib/supabase/server";
import { demoCaptureSize, SEGMENT_SECONDS, type AspectRatio } from "@/lib/video/higgsfield";
import { env, linkupConfigured } from "@/lib/env";
import type { BrandKit } from "@/lib/brand";
import { classifyPalette } from "@/lib/brand/palette";
import { isAuthorisedFontSource, pickFontFile } from "@/lib/video/fonts";
import { assertPublicUrl } from "@/lib/net/public-url";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import { createPublicCapturePage, createOfflineRenderContext } from "@/lib/video/capture-network";
import {
  looksBlocked,
  fetchSiteHtml,
  brandKitFromHtml,
  type PageVitals,
} from "@/lib/brand/blocked-site";

/**
 * Product-demo capture. Playwright drives a real Chromium session against the
 * product's URL, records the screen while it auto-scrolls through the whole
 * page (a "complete website overview"), and stores the resulting clip + a
 * poster frame in our `videos` bucket.
 *
 * Playwright is a WEB automation tool — it captures websites and web apps. A
 * native mobile/desktop binary can't be driven this way, so an "app" is still
 * captured through its web presence (the URL the user provides).
 */

export interface DemoCapture {
  url: string;
  thumbnailUrl: string;
  durationSec: number;
  /** Brand identity read off the same page during the capture. */
  brandKit?: BrandKit;
}

/**
 * Add a protocol if the user typed a bare domain, and check the shape.
 *
 * NOT a security boundary — it only checks that the hostname has a dot, which
 * "169.254.169.254" and "db.internal" both satisfy. Anything that hands a
 * caller-supplied URL to a fetch or a browser must go through
 * `assertPublicUrl` in lib/net/public-url instead, which resolves the name and
 * rejects private address space.
 */
export function normalizeUrl(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const withProto = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const u = new URL(withProto);
    if (u.hostname.includes(".")) return u.toString();
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Recording viewport for a ratio, capped so the long edge is
 * ≤ DEMO_CAPTURE_LONG_EDGE (even px).
 *
 * The maths moved to higgsfield.ts so the Video Generator can print the size a
 * demo is actually recorded at instead of the full preset dimensions.
 */
function captureViewport(ratio: AspectRatio): { width: number; height: number } {
  return demoCaptureSize(ratio);
}

// ---------------------------------------------------------------------------
// Brand-kit extraction — read the real logo, palette and typography off the
// rendered page so every generated asset can match the brand.
// ---------------------------------------------------------------------------

interface RawBrand {
  cssVars: Record<string, string>;
  themeColor: string | null;
  logoSrc: string | null;
  /**
   * The winning mark's own markup, when it is an inline <svg>.
   *
   * Inline SVG has no `src` to fetch, so it used to fall through to the
   * screenshot-crop tier — which bakes in the page background and is therefore
   * disqualified from becoming an overlay. That is backwards: an inline SVG is
   * the BEST possible overlay source, being vector art with real transparency.
   * Serialising it here lets `makeOverlayLogo` rasterise it exactly as it
   * already rasterises a fetched .svg file.
   */
  logoSvg: string | null;
  logoBox: { x: number; y: number; width: number; height: number } | null;
  /** Winning candidate's score — logged so a bad pick can be diagnosed. */
  logoScore: number;
  /** What identified the winner (alt/class/src), for the same reason. */
  logoLabel: string | null;
  appleTouchIcon: string | null;
  ogImage: string | null;
  iconHref: string | null;
  bg: string[];
  fg: string[];
  btnBg: string[];
  headingFont: string | null;
  bodyFont: string | null;
  fontSizes: string[];
}

/**
 * Font files a page fetched while we watched it load.
 *
 * Collected from the network rather than by reading @font-face rules, because
 * the stylesheets that declare them are usually cross-origin and the browser
 * refuses to expose `cssRules` for those. What the page actually downloaded is
 * both easier to observe and closer to the truth.
 */
function watchFontRequests(context: {
  on: (event: "response", fn: (res: { url: () => string; headers: () => Record<string, string> }) => void) => void;
}): string[] {
  const urls: string[] = [];
  context.on("response", (res) => {
    try {
      const url = res.url();
      const type = res.headers()["content-type"] ?? "";
      if (/^font\//.test(type) || /\.(woff2?|ttf|otf)(\?|$)/i.test(url)) {
        if (!urls.includes(url)) urls.push(url);
      }
    } catch {
      /* a header we could not read is one fewer font */
    }
  });
  return urls;
}

/** Runs inside the browser: tally colors/fonts and locate the logo. */
async function readRawBrand(page: Page): Promise<RawBrand> {
  return page.evaluate(() => {
    // Resolve ANY CSS colour to sRGB by letting the browser do it, rather than
    // pattern-matching one syntax.
    //
    // This used to match /rgba?\(...\)/ and return null for everything else,
    // which quietly dropped every modern colour: Chromium serialises a value
    // authored as oklch()/lab()/color() BACK in that same syntax from
    // getComputedStyle, it does not convert to rgb(). Tailwind v4's default
    // palette is oklch, so on a current site roughly half of all colour reads
    // were discarded and the "brand palette" was whatever legacy rgb() happened
    // to survive — while a brand colour declared as `--brand: oklch(...)` never
    // made it in at all.
    //
    // A 1x1 canvas converts every syntax, including named colours and hsl().
    // Invalid input leaves fillStyle untouched, so a sentinel detects it.
    const cv = document.createElement("canvas");
    cv.width = cv.height = 1;
    const g2d = cv.getContext("2d", { willReadFrequently: true });
    const seen = new Map<string, string | null>();
    const toHex = (c: string): string | null => {
      const key = (c ?? "").trim();
      if (!key || !g2d) return null;
      const hit = seen.get(key);
      if (hit !== undefined) return hit;
      let out: string | null = null;
      try {
        g2d.fillStyle = "#010203";
        g2d.fillStyle = key;
        // Unparseable: fillStyle kept the sentinel and the input was not it.
        if (g2d.fillStyle === "#010203" && !/^#010203$/i.test(key)) {
          seen.set(key, null);
          return null;
        }
        g2d.clearRect(0, 0, 1, 1);
        g2d.fillRect(0, 0, 1, 1);
        const d = g2d.getImageData(0, 0, 1, 1).data;
        // Matches the old `alpha < 0.15` cutoff, on a 0-255 scale.
        out =
          d[3] < 38
            ? null
            : `#${[d[0], d[1], d[2]].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
      } catch {
        out = null;
      }
      seen.set(key, out);
      return out;
    };
    const bump = (o: Record<string, number>, k: string | null) => {
      if (k) o[k] = (o[k] || 0) + 1;
    };
    const top = (o: Record<string, number>, n: number) =>
      Object.entries(o)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map((e) => e[0]);

    const rootStyle = getComputedStyle(document.documentElement);
    const cssVars: Record<string, string> = {};
    for (const name of Array.from(rootStyle)) {
      if (name.startsWith("--")) {
        const v = rootStyle.getPropertyValue(name).trim();
        // Store the RESOLVED colour when the value is one. `normalizeColor`
        // downstream only understands hex and rgb(), so a custom property
        // declared as oklch()/lab() — which is how a modern design system
        // states its brand colour — reached it verbatim and was thrown away.
        // Non-colour vars are kept as-is and normalizeColor still rejects them.
        if (v && v.length < 40) cssVars[name] = toHex(v) ?? v;
      }
    }

    const bg: Record<string, number> = {};
    const fg: Record<string, number> = {};
    const btnBg: Record<string, number> = {};
    const headingFonts: Record<string, number> = {};
    const bodyFonts: Record<string, number> = {};
    const sizes = new Set<string>();

    const els = Array.from(document.querySelectorAll("body *")).slice(0, 4000);
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const cs = getComputedStyle(el);
      bump(bg, toHex(cs.backgroundColor));
      bump(fg, toHex(cs.color));
      const tag = el.tagName.toLowerCase();
      const ff = cs.fontFamily.split(",")[0].replace(/["']/g, "").trim();
      if (/^h[1-3]$/.test(tag)) {
        bump(headingFonts, ff);
        sizes.add(cs.fontSize);
      } else if (["p", "span", "a", "li", "button"].includes(tag)) {
        bump(bodyFonts, ff);
        sizes.add(cs.fontSize);
      }
      const cls = (typeof el.className === "string" ? el.className : "").toLowerCase();
      if (tag === "button" || (tag === "a" && /btn|button|cta/.test(cls))) {
        bump(btnBg, toHex(cs.backgroundColor));
      }
    }

    // ---- Logo: score every plausible mark rather than taking the first. ----
    //
    // This used to be `document.querySelector` over a priority list, which
    // means the winner was whichever candidate came FIRST IN THE DOM. Several
    // of those selectors ('header img', 'img[src*="logo" i]') match a social
    // icon exactly as happily as a brand mark, so a header GitHub link whose
    // asset is named `github-logo.svg` beat the real logo twice over — once on
    // the "logo" substring, once on being early in the header.
    //
    // Size, shape, position and what the mark LINKS TO all distinguish a
    // wordmark from a 24px icon, and none of them can be expressed as selector
    // order. So every candidate is scored and the best one wins.

    /**
     * Asset names that are somebody else's brand.
     *
     * Deliberately short. An earlier draft of this list included generic
     * English — `cart`, `medium`, `arrow`, `menu` — and every one of them was a
     * false positive waiting to happen: "cart" is inside "Carta", "medium" is
     * inside Tailwind's own `font-medium` class, and blocking a company's real
     * logo is a far worse failure than admitting one extra candidate. Chrome
     * icons do not need a list — they are small, square, on the right, and link
     * nowhere, so the scoring below already buries them.
     */
    const THIRD_PARTY =
      /github|gitlab|bitbucket|twitter|linkedin|discord|facebook|instagram|youtube|tiktok|reddit|npmjs|producthunt|product-hunt|twitch|telegram|whatsapp|mastodon|bluesky|dribbble|behance|pinterest|app-?store|google-?play|x-(logo|icon)|icon-x\b/i;

    const ownHost = location.hostname.replace(/^www\./, "");
    const brandWord = ownHost.split(".")[0];
    const vw = window.innerWidth || 1366;

    /**
     * How this element names ITSELF — alt text, title, asset filename.
     *
     * Deliberately excludes the surrounding link's href. A header "star us on
     * GitHub" button points at github.com/acme/acme, which contains the brand
     * word, so scoring it as "names the brand" handed a third-party icon the
     * same bonus the real logo gets.
     */
    const selfText = (el: Element): string => {
      const attrs = ["alt", "aria-label", "title"]
        .map((a) => el.getAttribute(a) ?? "")
        .join(" ");
      const src = (el as HTMLImageElement).currentSrc || (el as HTMLImageElement).src || "";
      // The filename, not the whole URL: a CDN path can contain anything.
      const file = src.split("?")[0].split("/").pop() ?? "";
      return `${attrs} ${file}`;
    };

    /** Where the mark's link goes: "home", "external", or "" for neither. */
    const linkTarget = (el: Element): "home" | "external" | "" => {
      const href = el.closest("a")?.getAttribute("href");
      if (!href || href === "#") return "";
      if (href === "/") return "home";
      try {
        const u = new URL(href, location.href);
        const host = u.hostname.replace(/^www\./, "");
        if (host !== ownHost) return "external";
        return u.pathname === "/" || u.pathname === "" ? "home" : "";
      } catch {
        return "";
      }
    };

    const candidates = Array.from(
      document.querySelectorAll(
        'header img, header svg, nav img, nav svg, [role="banner"] img, [role="banner"] svg,' +
          '[class*="header" i] img, [class*="header" i] svg,' +
          '[class*="navbar" i] img, [class*="navbar" i] svg,' +
          '[class*="logo" i] img, [class*="logo" i] svg, [id*="logo" i] img, [id*="logo" i] svg,' +
          '[data-testid*="logo" i] img, [data-testid*="logo" i] svg,' +
          'a[href="/"] img, a[href="/"] svg, img[alt*="logo" i], img[src*="logo" i]',
      ),
    );

    /**
     * The first mark in the header's top-left — the logo slot.
     *
     * Nearly every site on the web puts its brand there, and it is the only
     * signal that survives when a logo has no link, no alt text and no asset
     * filename to read. ZidaneAI's own site is exactly that case: a 32x32
     * inline SVG in a bare <span>, `aria-hidden`, no wrapping anchor. It scored
     * 0.67 out of everything below — winning by accident when it won at all —
     * because the only points available to it were its size.
     */
    let slotEl: Element | null = null;
    for (const el of candidates) {
      if (el.closest("footer")) continue;
      if (!el.closest('header, [role="banner"], nav')) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 8) continue;
      if (r.x < vw / 3 && r.y < 200) {
        slotEl = el;
        break;
      }
    }

    /**
     * A candidate must clear this to be believed.
     *
     * Without a floor, "the highest score" can be a score of 0.67 — an element
     * that lost every signal and scraped past zero on its size alone. Falling
     * through to the head assets (apple-touch-icon, og:image, favicon) is a far
     * better answer than a mark we have no actual reason to think is the logo.
     */
    const MIN_SCORE = 12;

    let logoEl: Element | null = null;
    let logoScore = 0;
    for (const el of candidates) {
      // A logo inside the footer is the footer's copy, shown at a size and
      // treatment chosen for small print — the header mark is the real one.
      if (el.closest("footer")) continue;

      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 8 || r.width > 600 || r.height > 300) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) < 0.1) {
        continue;
      }

      const text = selfText(el);
      const target = linkTarget(el);
      // An asset named for another company is that company's mark — a customer
      // logo in a "trusted by" strip, or a social icon. The one exception is a
      // company scanning its own site: github.com's logo is allowed to be
      // called github.svg.
      if (THIRD_PARTY.test(text) && !THIRD_PARTY.test(ownHost)) continue;

      const namesLogo = /logo|wordmark|brandmark/i.test(text);
      const namesBrand = brandWord.length > 2 && text.toLowerCase().includes(brandWord);
      const ratio = r.width / Math.max(1, r.height);
      const wordmarkShape = ratio >= 1.6 && ratio <= 9;

      // A candidate must IDENTIFY ITSELF as this brand's mark. Scoring alone
      // cannot express that: every signal below is a matter of degree, so with
      // nothing but degrees the best of a bad field still wins, and a page with
      // no logo image at all always yields something.
      //
      // That is not hypothetical. On a portfolio whose header wordmark is plain
      // TEXT — so there is no correct image anywhere on the page — the winner
      // was a 100x100 project thumbnail called "Codex logo": +20 for containing
      // the word "logo", +25 for being large, and it shipped as the brand. The
      // same shape of failure previously burned a GitHub icon into every clip.
      //
      // So require one real identity signal: it links home (what a logo is
      // FOR), or it is named after this company, or it both calls itself a logo
      // AND has wordmark proportions. A square thumbnail that merely has "logo"
      // in its filename satisfies none of these. Finding nothing is the correct
      // answer here — postproduce ships the clip unbranded, which is exactly
      // what it is designed to do when no mark can be proven.
      // Occupying the header's LOGO SLOT is the fourth such signal, and for a
      // large class of modern sites it is the only one available. ZidaneAI's
      // own header is a 32x32 inline <svg> in a bare <span>: aria-hidden, no
      // alt, no title, no anchor, no filename. It links nowhere, names nothing,
      // and is unmistakably the logo to any human who looks at the page. Under
      // the three signals above it was rejected outright, and the scan fell
      // through to the favicon tier with `logo pick: score 0`.
      //
      // The slot is a structural claim, not a textual one — first mark inside
      // the header, top-left — which is why it survives where reading
      // attributes does not. It also stays narrow enough to keep out the
      // failures above: a project thumbnail in a portfolio grid is not inside
      // <header> and not in its top-left corner.
      const inSlot = el === slotEl;
      if (!(target === "home" || namesBrand || (namesLogo && wordmarkShape) || inSlot)) continue;

      let score = 0;
      // Where the mark links is the single most reliable signal there is.
      // A logo links home; that is what a logo is FOR. A mark that links off
      // the site is, by construction, somebody else's — which catches every
      // third-party icon, including the ones no blocklist would name.
      if (target === "home") score += 30;
      else if (target === "external") score -= 25;
      if (namesLogo) score += 20;
      if (namesBrand) score += 15;
      // Bigger is more likely to be the brand and less likely to be an icon,
      // with diminishing returns so a hero image cannot run away with it.
      score += Math.min(25, Math.sqrt(r.width * r.height) / 3);
      // Wordmark proportions. A 24x24 square in a header is an icon.
      if (wordmarkShape) score += 12;
      if (inSlot) score += 25;
      // A 24x24 square in a header is usually an icon — but a compact square
      // mark IN THE LOGO SLOT is a brand mark, and a great many brands use one,
      // so the penalty is not applied there. It is also smaller than it was:
      // at -20 it could sink a genuine logo below every other signal combined.
      if (!inSlot && r.width < 40 && r.height < 40) score -= 12;
      // Headers put the brand on the left and the social/CTA cluster on the right.
      if (r.x < vw / 3) score += 10;
      else if (r.x > vw * 0.6) score -= 12;
      // A real image asset beats an inline SVG we would have to screenshot.
      if (el.tagName.toLowerCase() === "img") score += 8;

      if (score > logoScore && score >= MIN_SCORE) {
        logoScore = score;
        logoEl = el;
      }
    }

    let logoSrc: string | null = null;
    let logoSvg: string | null = null;
    let logoBox: RawBrand["logoBox"] = null;
    let logoLabel: string | null = null;
    if (logoEl) {
      if (logoEl.tagName.toLowerCase() === "svg") {
        // `defs` (gradients, masks) live inside the element, so outerHTML is
        // self-contained. Capped because a decorative illustration can run to
        // megabytes and nothing that large is a logo.
        let markup = logoEl.outerHTML;
        // The namespace has to be ADDED. Inline SVG in an HTML document
        // inherits it from the parser and so is almost never written with an
        // `xmlns`, but the overlay rasterises this markup as a STANDALONE
        // document via a data URI — where the attribute is mandatory. Without
        // it the browser parses the data URI as generic XML, the <img> lands in
        // the `broken` state with naturalWidth 0, and the transparency probe
        // throws. Measured on this exact mark: broken without it, and 72.5%
        // transparent with it. The symptom was silent — "logo is not
        // transparent, clips stay unbranded" — so it read as a property of the
        // logo rather than as a missing attribute.
        if (markup && !/\sxmlns\s*=/.test(markup)) {
          markup = markup.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
        }
        // Same story for xlink, which older marks still use for <use href>.
        if (markup && /xlink:/.test(markup) && !/xmlns:xlink\s*=/.test(markup)) {
          markup = markup.replace(
            /^<svg/i,
            '<svg xmlns:xlink="http://www.w3.org/1999/xlink"',
          );
        }
        if (markup && markup.length < 200_000) logoSvg = markup;
      }
      // Falls back to the class attribute purely so the log line below can
      // name an inline SVG that carries no alt, title or src at all.
      logoLabel =
        (selfText(logoEl).trim() || logoEl.getAttribute("class") || "").slice(0, 120) || null;
      const img = logoEl as HTMLImageElement;
      const src = img.currentSrc || img.src || "";
      if (src && /^https?:/.test(src)) logoSrc = src;
      // Fall back to a CSS background-image on the element or a near ancestor.
      if (!logoSrc) {
        let node: Element | null = logoEl;
        for (let i = 0; i < 4 && node; i++) {
          const bi = getComputedStyle(node).backgroundImage;
          const m = bi && bi.match(/url\(["']?(.*?)["']?\)/);
          if (m && /^https?:/.test(m[1])) {
            logoSrc = m[1];
            break;
          }
          node = node.parentElement;
        }
      }
      const r = logoEl.getBoundingClientRect();
      if (r.width > 8 && r.height > 8 && r.width < 600 && r.height < 300) {
        logoBox = { x: r.x, y: r.y, width: r.width, height: r.height };
      }
    }

    // Head assets — clean, reliable brand marks on almost every site.
    const linkHref = (rel: string) => {
      const l = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
      return l?.href ?? null;
    };
    const appleTouchIcon = linkHref("apple-touch-icon") || linkHref("apple-touch-icon-precomposed");
    const iconLinks = Array.from(
      document.querySelectorAll('link[rel~="icon"]'),
    ) as HTMLLinkElement[];
    const sizeOf = (l: HTMLLinkElement) =>
      parseInt((l.getAttribute("sizes") || "0").split("x")[0], 10) || 0;
    iconLinks.sort((a, b) => sizeOf(b) - sizeOf(a));
    const iconHref = iconLinks[0]?.href ?? null;
    const ogImage =
      (document.querySelector('meta[property="og:image"]') as HTMLMetaElement | null)?.content ??
      (document.querySelector('meta[name="og:image"]') as HTMLMetaElement | null)?.content ??
      null;
    const meta = document.querySelector('meta[name="theme-color"]') as HTMLMetaElement | null;

    return {
      cssVars,
      themeColor: meta?.content ?? null,
      logoSrc,
      logoSvg,
      logoBox,
      logoScore,
      logoLabel,
      appleTouchIcon,
      ogImage,
      iconHref,
      bg: top(bg, 8),
      fg: top(fg, 8),
      btnBg: top(btnBg, 4),
      headingFont: top(headingFonts, 1)[0] ?? null,
      bodyFont: top(bodyFonts, 1)[0] ?? null,
      fontSizes: Array.from(sizes),
    } as RawBrand;
  });
}

/** An image we have in hand: bytes plus enough to store or re-render it. */
interface FetchedImage {
  buf: Buffer;
  contentType: string;
  ext: string;
}

/**
 * Download a remote image. Kept separate from storing it because the overlay
 * pipeline needs the BYTES, not a URL: re-fetching our own upload just to look
 * at its pixels would be a second round trip for data we already had.
 */
async function fetchImage(url: string): Promise<FetchedImage | null> {
  try {
    const res = await fetchPublicUrl(url, {
      signal: AbortSignal.timeout(15_000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null; // too small to be a real logo
    const ext = ct.includes("svg")
      ? "svg"
      : ct.includes("png")
        ? "png"
        : ct.includes("webp")
          ? "webp"
          : ct.includes("jpeg") || ct.includes("jpg")
            ? "jpg"
            : "img";
    return { buf, contentType: ct, ext };
  } catch {
    return null;
  }
}

/** Put bytes in our public bucket and return the public URL. null on any issue. */
async function storeImage(
  img: FetchedImage,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  try {
    const db = createAdminClient();
    const path = `${workspaceId}/${name}.${img.ext}`;
    const up = await db.storage
      .from("videos")
      .upload(path, img.buf, { contentType: img.contentType, upsert: true });
    if (up.error) return null;
    return db.storage.from("videos").getPublicUrl(path).data.publicUrl;
  } catch {
    return null;
  }
}

/** Download a remote image and re-host it in our storage. null on any issue. */
async function uploadRemoteImage(
  url: string,
  workspaceId: string,
  name: string,
): Promise<string | null> {
  const img = await fetchImage(url);
  return img ? storeImage(img, workspaceId, name) : null;
}

/** Rendered width for the overlay master, at 2x scale. Comfortably above the
 *  ~12% of frame width the compositor uses at 1080p, so it downscales cleanly. */
const OVERLAY_LOGO_WIDTH = 512;

/**
 * Turn a logo asset into a transparent PNG that ffmpeg can actually composite,
 * or return null if it cannot be one.
 *
 * Two problems are solved in the same pass, both by the browser we already run:
 *
 *  1. SVG. ffmpeg ships without librsvg, so it cannot decode SVG at all — and
 *     SVG is what a good site serves for its logo, so the BEST asset was the
 *     one most likely to fail. Chromium renders it and we screenshot the
 *     result, which also means it is rasterized at the size we want rather
 *     than upscaled from whatever bitmap happened to be lying around.
 *
 *  2. Transparency. An apple-touch-icon is opaque by Apple's spec, a screenshot
 *     crop has the page background baked in, and plenty of PNGs are simply
 *     flattened. Composited over footage each becomes a solid rectangle in the
 *     corner. There is no way to tell from the file type, so the pixels are
 *     read: if the mark has no meaningful transparency it is rejected here and
 *     the clip ships unbranded, which is the better of the two bad outcomes.
 *
 * Runs in its own context — never the caller's. The demo capture's context is
 * recording, and a second page inside it would flush a second .webm that the
 * "find the recording" step could pick up instead of the real one.
 */
async function makeOverlayLogo(
  browser: Browser,
  img: FetchedImage,
): Promise<FetchedImage | null> {
  // Inlined as a data URI rather than loaded by URL: a cross-origin image
  // taints the canvas and getImageData then throws, which is exactly the call
  // the transparency test depends on. Data URIs do not taint.
  const dataUri = `data:${img.contentType};base64,${img.buf.toString("base64")}`;
  let context: Awaited<ReturnType<Browser["newContext"]>> | null = null;
  try {
    context = await createOfflineRenderContext(browser, {
      viewport: { width: OVERLAY_LOGO_WIDTH, height: OVERLAY_LOGO_WIDTH },
      // The screenshot is the master the compositor scales down from, so
      // render it at 2x and let ffmpeg do the shrinking.
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    // An explicit width matters for SVG: with no intrinsic size Chromium falls
    // back to 300x150, and the mark would be rasterized at that instead.
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0;background:transparent}` +
        `img{display:block;width:${OVERLAY_LOGO_WIDTH}px;height:auto}</style>` +
        `<img id="logo" src="${dataUri}">`,
    );
    const el = page.locator("#logo");
    await el.waitFor({ state: "visible", timeout: 10_000 });

    const alphaShare = await page.evaluate(() => {
      const im = document.getElementById("logo") as HTMLImageElement | null;
      if (!im || !im.complete) return null;
      // Sample at a fixed small size: we are asking "is any of this see
      // through", not measuring it, and 64x64 answers that for any logo.
      const S = 64;
      const canvas = document.createElement("canvas");
      canvas.width = S;
      canvas.height = S;
      const g = canvas.getContext("2d");
      if (!g) return null;
      try {
        g.drawImage(im, 0, 0, S, S);
        const data = g.getImageData(0, 0, S, S).data;
        let clear = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
        return clear / (S * S);
      } catch {
        return null;
      }
    });

    // A logo on a transparent ground is typically a third or more clear pixels.
    // The floor is low because a dense square wordmark is a legitimate logo and
    // still has soft edges; what it excludes is the fully flattened rectangle.
    if (alphaShare === null || alphaShare < 0.05) return null;

    const shot = await el.screenshot({ type: "png", omitBackground: true });
    if (shot.length < 200) return null;
    return { buf: shot, contentType: "image/png", ext: "png" };
  } catch {
    return null;
  } finally {
    await context?.close().catch(() => {});
  }
}

/**
 * Prepare a logo the USER gave us, rather than one we found.
 *
 * Same treatment as a scraped logo — rehosted, rasterized, transparency
 * checked — because the file being hand-picked says nothing about whether
 * ffmpeg can read it. People upload SVGs and flattened JPEGs of their logo,
 * and both would compose as badly as anything the scraper turns up.
 *
 * Returns the display URL always, and the overlay URL only when one could be
 * made. An explicit choice still cannot become a white box.
 */
export async function prepareLogoAsset(
  url: string,
  workspaceId: string,
): Promise<{ logoUrl: string; logoOverlayUrl?: string } | null> {
  const img = await fetchImage(url);
  if (!img) return null;

  const name = `logo_${randomUUID()}`;
  const logoUrl = (await storeImage(img, workspaceId, name)) ?? url;

  const browser = await launchBrowser().catch(() => null);
  if (!browser) return { logoUrl };
  try {
    const overlay = await makeOverlayLogo(browser, img);
    if (!overlay) return { logoUrl };
    const logoOverlayUrl = await storeImage(overlay, workspaceId, `${name}-overlay`);
    return { logoUrl, logoOverlayUrl: logoOverlayUrl ?? undefined };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Domain-keyed icon services.
 *
 * Both of these DECLINE a host they have no icon for, which is the property
 * that makes them usable: measured against a nonsense domain, each returned no
 * image at all, so a result from either is evidence the icon is real.
 *
 * Two services deliberately excluded, both measured on 2026-08-27:
 *
 *   Clearbit  `logo.clearbit.com/<domain>` — the obvious candidate, and gone.
 *             Connection refused, not a 404, so a caller would hang on the
 *             timeout and then fall through silently, forever.
 *
 *   favicone  Higher resolution than either of these — a true 256x256 for
 *             wellfound.com where Google served 32x32 despite being asked for
 *             256 — but it NEVER declines. A domain that does not exist came
 *             back with a generic blank-page glyph at 270,398 bytes, which is
 *             byte-for-byte the same size as its genuine wellfound and stripe
 *             icons. So neither size nor status distinguishes its placeholder
 *             from a real mark, and "largest wins" would rank that placeholder
 *             above every honest answer. A correct 32x32 is worth more here
 *             than a 256x256 picture of nothing.
 */
const ICON_SERVICES = (host: string): string[] => [
  `https://www.google.com/s2/favicons?sz=256&domain=${encodeURIComponent(host)}`,
  `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`,
];

/**
 * The brand's icon from whichever service holds the best copy of it.
 *
 * Queried together rather than in order: they are independent and neither is
 * reliably the larger, so taking the biggest result means one being stingy does
 * not cost the quality. Both returning nothing means the host has no icon
 * anywhere, and the caller drops to the site's own og:image and favicon.
 */
async function findIconViaService(host: string): Promise<FetchedImage | null> {
  const found = await Promise.all(
    ICON_SERVICES(host).map((u) => fetchImage(u).catch(() => null)),
  );
  // 512 bytes rather than fetchImage's 200: at this size the floor is filtering
  // out a service's 1x1 "no icon" pixel, not a truncated download.
  const usable = found.filter((r): r is FetchedImage => !!r && r.buf.length >= 512);
  if (!usable.length) return null;
  usable.sort((a, b) => b.buf.length - a.buf.length);
  return usable[0];
}

/** Web-search the brand logo via Linkup and return the best image URL. */
async function findLogoViaLinkup(host: string): Promise<string | null> {
  if (!linkupConfigured) return null;
  const root = host.replace(/^www\./, "").split(".")[0];
  try {
    const res = await fetch("https://api.linkup.so/v1/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.linkupKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: `official brand logo of ${host} (${root}) — transparent PNG or SVG`,
        depth: "standard",
        outputType: "searchResults",
        includeImages: true,
        maxResults: 10,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ type?: string; url?: string; name?: string }>;
    };
    const images = (data.results ?? []).filter((r) => r.type === "image" && r.url);
    if (!images.length) return null;

    /**
     * The brand name must actually appear. This is a HARD filter, not a score.
     *
     * Scoring alone had no floor and no relevance requirement, so it returned
     * the best of whatever came back — and a web search for a small brand comes
     * back full of famous ones. Measured against the live API for wellfound.com:
     * ten image results, NONE of them wellfound — Micromax, Huawei, McDonald's,
     * Wells Fargo and four Airbnbs. Every one scored 4 on "logo" + ".png" with
     * zero relevance, so they tied and array order picked the winner. A real
     * workspace ended up with the Wells Fargo wordmark stored as its brand mark,
     * on the site's logo panel and headed for the end card of every clip.
     *
     * Returning null instead drops through to og:image and then the favicon,
     * which are served BY THE SITE ITSELF — worse-looking than a real logo file
     * and unable to be wrong about whose logo it is.
     *
     * Compared with separators stripped so "Acme_Corp_logo.svg" still matches
     * the root "acmecorp", and skipped entirely for roots under three
     * characters, where substring matching means nothing.
     */
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const rootKey = norm(root);
    if (rootKey.length < 3) return null;
    const named = images.filter((r) => norm(`${r.url} ${r.name ?? ""}`).includes(rootKey));
    if (!named.length) {
      console.log(
        `[capture] logo search returned ${images.length} images, none naming "${root}" — ignoring them`,
      );
      return null;
    }

    const score = (u: string, n?: string) => {
      const s = `${u} ${n ?? ""}`.toLowerCase();
      let sc = 0;
      if (s.includes("logo")) sc += 3;
      if (/\.svg(\?|$)/.test(u)) sc += 2;
      if (/\.png(\?|$)/.test(u)) sc += 1;
      if (s.includes("wikimedia") || s.includes("wikipedia")) sc += 1;
      return sc;
    };
    named.sort((a, b) => score(b.url!, b.name) - score(a.url!, a.name));
    return named[0]?.url ?? null;
  } catch {
    return null;
  }
}

/** Normalize a CSS color string to #rrggbb, or null if not a solid color. */
function normalizeColor(c: string): string | null {
  const s = c.trim().toLowerCase();
  const hex = s.match(/^#([0-9a-f]{6})$/);
  if (hex) return `#${hex[1]}`;
  const short = s.match(/^#([0-9a-f]{3})$/);
  if (short) return `#${short[1].split("").map((x) => x + x).join("")}`;
  const rgb = s.match(/^rgba?\(([^)]+)\)/);
  if (rgb) {
    const p = rgb[1].split(",").map((x) => parseFloat(x.trim()));
    const [r, g, b, a] = p;
    if (a !== undefined && a < 0.15) return null;
    const h = (n: number) =>
      Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  return null;
}

/**
 * Shape the raw browser data into a BrandKit.
 *
 * The palette work — collapsing near-identical shades and deciding which
 * colour plays which role — lives in lib/brand/palette so it is testable
 * without a browser. What this function contributes is only the translation
 * from CSS colour strings to hex.
 */
function deriveBrandKit(raw: RawBrand, url: string): BrandKit {
  const palette = classifyPalette({
    buttonColors: raw.btnBg.map(normalizeColor),
    themeColor: raw.themeColor ? normalizeColor(raw.themeColor) : null,
    varColors: Object.values(raw.cssVars).map(normalizeColor),
    backgrounds: raw.bg.map(normalizeColor),
    foregrounds: raw.fg.map(normalizeColor),
  });

  const fontSizes = [...new Set(raw.fontSizes)]
    .sort((a, b) => parseFloat(b) - parseFloat(a))
    .slice(0, 4);

  return {
    colors: palette.colors,
    primaryColor: palette.primary,
    accentColor: palette.accent,
    backgroundColor: palette.background,
    textColor: palette.text,
    headingFont: raw.headingFont ?? undefined,
    bodyFont: raw.bodyFont ?? undefined,
    fontSizes,
    themeColor: raw.themeColor ? normalizeColor(raw.themeColor) ?? undefined : undefined,
    capturedFrom: url,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Extract a BrandKit from an already-loaded page. Uploads a logo crop to
 * storage when the logo is inline SVG (no direct image URL).
 */
async function extractBrandKit(
  page: Page,
  opts: { workspaceId: string; slug: string; fontUrls?: string[] },
): Promise<BrandKit> {
  const raw = await readRawBrand(page);
  const kit = deriveBrandKit(raw, page.url());
  // The logo pick is the single most visible thing this function decides and
  // the hardest to diagnose after the fact — the stored kit records the winner
  // but never the contest. One line of provenance makes "why is our logo a
  // GitHub icon" answerable without reproducing the scrape.
  console.log(
    `[capture] logo pick: score ${Math.round(raw.logoScore)} — ${raw.logoLabel ?? "(unnamed)"}` +
      (raw.logoBox ? ` @ ${Math.round(raw.logoBox.width)}x${Math.round(raw.logoBox.height)}` : ""),
  );
  const host = (() => {
    try {
      return new URL(page.url()).hostname;
    } catch {
      return "";
    }
  })();
  const logoName = `${opts.slug}-logo`;

  let logoUrl: string | undefined;
  // The asset the overlay may be built from. Only tiers that yield a REAL logo
  // file qualify — a screenshot crop, an apple-touch-icon, a share card and a
  // favicon are all fine to look at and none of them belong over footage.
  let overlaySource: FetchedImage | null = null;

  // 1. On-page <img> / background-image logo — the real asset.
  if (raw.logoSrc) {
    const img = await fetchImage(raw.logoSrc);
    if (img) {
      overlaySource = img;
      logoUrl = (await storeImage(img, opts.workspaceId, logoName)) ?? raw.logoSrc;
    } else {
      logoUrl = raw.logoSrc;
    }
  }

  // 1b. Inline <svg> mark — vector art with real transparency, so it is an
  // overlay source in its own right. Ranked above the screenshot crop because
  // the crop of this same element would carry the header's background with it
  // and be rejected for compositing.
  if (!logoUrl && raw.logoSvg) {
    overlaySource = {
      buf: Buffer.from(raw.logoSvg, "utf8"),
      contentType: "image/svg+xml",
      ext: "svg",
    };
  }

  // 2. Screenshot the located header logo element (real rendered logo).
  if (!logoUrl && !overlaySource && raw.logoBox) {
    try {
      const shot = await page.screenshot({
        clip: {
          x: Math.max(0, raw.logoBox.x),
          y: Math.max(0, raw.logoBox.y),
          width: Math.min(600, raw.logoBox.width),
          height: Math.min(300, raw.logoBox.height),
        },
        type: "png",
      });
      const db = createAdminClient();
      const logoPath = `${opts.workspaceId}/${logoName}.png`;
      const up = await db.storage
        .from("videos")
        .upload(logoPath, shot, { contentType: "image/png", upsert: true });
      if (!up.error) {
        logoUrl = db.storage.from("videos").getPublicUrl(logoPath).data.publicUrl;
      }
    } catch {
      /* crop is best-effort */
    }
  }

  // 3. apple-touch-icon — a clean square brand mark on almost every site.
  if (!logoUrl && raw.appleTouchIcon) {
    logoUrl =
      (await uploadRemoteImage(raw.appleTouchIcon, opts.workspaceId, logoName)) ?? undefined;
  }

  // 4. Web-search fallback via Linkup. A real logo file like tier 1, so it can
  // also feed the overlay — including when it is the SVG the search prefers,
  // which is rasterized below rather than handed to ffmpeg.
  if (!logoUrl && host) {
    const found = await findLogoViaLinkup(host);
    if (found) {
      const img = await fetchImage(found);
      if (img) {
        overlaySource = img;
        logoUrl = (await storeImage(img, opts.workspaceId, logoName)) ?? found;
      } else {
        logoUrl = found;
      }
    }
  }

  // 4b. Deterministic icon services, keyed by DOMAIN rather than by a query.
  //
  // Ranked above og:image because an og:image is a 1200x630 share banner — a
  // scene with a headline across it — and a small correct mark is a better
  // logo than a large correct poster. Ranked below the search because when the
  // search does match it returns a full-resolution wordmark, where this returns
  // an upscaled favicon.
  //
  // The point of this tier is that it CANNOT be wrong about whose brand it is.
  // There is no query to misinterpret: you hand it a hostname and it returns
  // that host's icon, or nothing. That is the property the search lacks — see
  // findLogoViaLinkup, which answered "wellfound.com" with the Wells Fargo
  // wordmark. It also still works when the page could not be parsed at all,
  // which is exactly when every earlier tier has failed.
  //
  // Three services rather than one so a single outage is not a missing logo,
  // and the LARGEST payload wins: these all serve the same icon at whatever
  // resolution they hold, and for an icon, bytes track pixels closely enough.
  if (!logoUrl && host) {
    const icon = await findIconViaService(host);
    if (icon) {
      // Not an overlay source. These are flattened favicons — opaque, often
      // ICO, and typically upscaled from 32px; makeOverlayLogo would reject
      // them anyway, and compositing one over footage would be a grey box.
      logoUrl = (await storeImage(icon, opts.workspaceId, logoName)) ?? undefined;
      if (logoUrl) console.log(`[capture] logo from icon service for ${host}`);
    }
  }

  // 5. og:image, then favicon — last resorts.
  if (!logoUrl && raw.ogImage) {
    logoUrl = (await uploadRemoteImage(raw.ogImage, opts.workspaceId, logoName)) ?? undefined;
  }
  if (!logoUrl && raw.iconHref) {
    logoUrl = (await uploadRemoteImage(raw.iconHref, opts.workspaceId, logoName)) ?? raw.iconHref;
  }

  // Build the composite-safe master, if any tier gave us something real enough
  // to make one. Best-effort by contract: no overlay logo simply means the
  // clip is not branded, and that is a better result than a white box.
  let logoOverlayUrl: string | undefined;
  const browser = page.context().browser();
  if (overlaySource && browser) {
    const overlay = await makeOverlayLogo(browser, overlaySource);
    if (overlay) {
      logoOverlayUrl =
        (await storeImage(overlay, opts.workspaceId, `${logoName}-overlay`)) ?? undefined;
      // An inline SVG has no file of its own to show anywhere else, so the
      // rasterised overlay doubles as the DISPLAY logo. A transparent PNG of
      // the real mark is a better thing to put in the brand panel and on the
      // end card than the favicon this would otherwise fall through to.
      if (!logoUrl && logoOverlayUrl) logoUrl = logoOverlayUrl;
    } else {
      console.log(`[capture] logo is not transparent — clips stay unbranded (${host})`);
    }
  }

  // Typography: which of the font files the page actually loaded belong to the
  // families we read off it, and are we allowed to fetch them.
  const siteUrl = page.url();
  const allowed = (opts.fontUrls ?? []).filter((u) => isAuthorisedFontSource(u, siteUrl));
  const headingFontUrl = pickFontFile(kit.headingFont, allowed);
  const bodyFontUrl = pickFontFile(kit.bodyFont, allowed);
  const fontSource = headingFontUrl || bodyFontUrl
    ? (new URL(headingFontUrl ?? bodyFontUrl!).hostname === "fonts.gstatic.com"
        ? ("google" as const)
        : ("site" as const))
    : undefined;
  if (opts.fontUrls?.length) {
    console.log(
      `[capture] fonts: ${opts.fontUrls.length} loaded, ${allowed.length} authorised, ` +
        `heading=${headingFontUrl ? "yes" : "no"} body=${bodyFontUrl ? "yes" : "no"}`,
    );
  }

  // Marked as a SCAN so `saveBrandKit` knows this is the scraper's opinion and
  // not a person's: a logo the user uploaded deliberately outranks whatever the
  // scoring above picked, however confident that pick was.
  return {
    ...kit,
    logoUrl,
    logoOverlayUrl,
    logoSource: "scan",
    headingFontUrl,
    bodyFontUrl,
    fontSource,
  };
}

/**
 * Launch Chromium resiliently.
 *
 * Playwright's default `headless: true` uses the separate `chrome-headless-shell`
 * binary. On some Windows setups that shell crashes on startup with
 * STATUS_DLL_INIT_FAILED (exit 0xC0000142) when spawned from the Next.js server
 * process, surfacing as "Target page, context or browser has been closed" — so
 * the brand scan and demo capture fail even though the site is perfectly
 * reachable. The full Chromium build in new-headless mode (`channel: "chromium"`)
 * is unaffected. Try the fast shell first, fall back to full Chromium, and cache
 * whichever works so we pay the fallback cost at most once per process.
 */
let preferredLaunch: "shell" | "chromium" | null = null;

export async function launchBrowser(): Promise<Browser> {
  const strategies: Array<{ id: "shell" | "chromium"; opts: LaunchOptions }> = [
    { id: "shell", opts: { headless: true } },
    { id: "chromium", opts: { channel: "chromium", headless: true } },
  ];
  // Once we know which one works, try it first (the other stays as a fallback).
  strategies.sort((a, b) =>
    a.id === preferredLaunch ? -1 : b.id === preferredLaunch ? 1 : 0,
  );

  let lastErr: unknown;
  for (const s of strategies) {
    try {
      const browser = await chromium.launch(s.opts);
      if (preferredLaunch !== s.id) {
        preferredLaunch = s.id;
        console.log(`[capture] Chromium launched via "${s.id}"`);
      }
      return browser;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Standalone brand-kit extraction: open the URL, read the identity, done.
 * Used by the on-demand "scan brand style" endpoint.
 */
export async function extractBrandKitFromUrl(
  url: string,
  opts: { workspaceId: string },
): Promise<BrandKit> {
  const publicUrl = await assertPublicUrl(url);
  if (!publicUrl) throw new Error("Only public HTTP(S) URLs can be captured");
  url = publicUrl;
  const browser = await launchBrowser();
  try {
    const { context, page } = await createPublicCapturePage(browser, {
      viewport: { width: 1366, height: 900 },
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const fontUrls = watchFontRequests(context);
    // Navigation failing outright is itself a verdict — a bot wall that hangs
    // and a site that is down look identical from here, and both mean "we did
    // not see this page". Tracked rather than thrown so the fallback still runs.
    let reached = true;
    await page
      .goto(url, { waitUntil: "networkidle", timeout: 45_000 })
      .catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }))
      .catch(() => {
        reached = false;
      });

    if (reached) {
      await page.waitForTimeout(1_200);
      await dismissBanners(page);
    }

    // Did we actually get the site, or a challenge page wearing its URL?
    const vitals: PageVitals = reached
      ? await page
          .evaluate(() => ({
            title: document.title ?? "",
            bodyChars: document.body?.innerText?.length ?? 0,
            elementCount: document.querySelectorAll("body *").length,
            stylesheets: document.styleSheets.length,
          }))
          .catch(() => ({ title: "", bodyChars: 0, elementCount: 0, stylesheets: 0 }))
      : { title: "", bodyChars: 0, elementCount: 0, stylesheets: 0 };

    if (!reached || looksBlocked(vitals)) {
      // Reading this document would persist an error shell as the brand — the
      // "#000000 / Times" result. Ask Firecrawl, which proxies and gets through.
      console.log(
        `[capture] live read rejected (${reached ? `title="${vitals.title}" els=${vitals.elementCount}` : "unreachable"}) — trying Firecrawl`,
      );
      const html = await fetchSiteHtml(url);
      if (html) {
        const kit = await brandKitFromHtml(html, url, (asset) =>
          prepareLogoAsset(asset, opts.workspaceId),
        );
        await context.close();
        return kit;
      }
      // No Firecrawl key, or it could not reach the site either.
      //
      // REFUSE rather than read the document we just rejected. An earlier
      // version only bailed when navigation had failed outright and otherwise
      // fell through to the rendered read — so whenever Firecrawl was slow (it
      // times out under concurrent scans) the "Access Denied" shell was parsed
      // after all, and godaddy.com stored `#000000` + `Times` as its brand.
      // Having already decided this is not the site, reading it anyway is the
      // one thing we must not do.
      //
      // Callers handle this: /api/onboarding/analyze catches and keeps the text
      // analysis, and /api/brand/extract returns "couldn't read that site",
      // which is true and actionable. Both beat a confidently wrong identity.
      await context.close();
      throw new Error(
        reached ? `Blocked or unreadable page at ${url}` : `Could not load ${url}`,
      );
    }

    const kit = await extractBrandKit(page, {
      workspaceId: opts.workspaceId,
      slug: `kit_${randomUUID()}`,
      fontUrls,
    });
    await context.close();
    return kit;
  } finally {
    await browser.close().catch(() => {});
  }
}

/** Best-effort dismissal of the usual cookie / consent overlays. */
async function dismissBanners(page: Page): Promise<void> {
  const labels = ["Accept", "Accept all", "I agree", "Got it", "Allow all", "Agree"];
  for (const label of labels) {
    try {
      const btn = page.getByRole("button", { name: new RegExp(`^${label}$`, "i") }).first();
      if (await btn.isVisible({ timeout: 500 })) {
        await btn.click({ timeout: 1000 });
        break;
      }
    } catch {
      /* no such banner — fine */
    }
  }
}

/** Smoothly scroll from top to bottom so the recording shows the full page. */
async function scrollThrough(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const height = document.body.scrollHeight;
    const vh = window.innerHeight;
    const steps = Math.min(24, Math.max(6, Math.ceil((height - vh) / (vh * 0.6))));
    for (let i = 1; i <= steps; i++) {
      window.scrollTo({ top: (height - vh) * (i / steps), behavior: "smooth" });
      await sleep(450);
    }
    await sleep(600);
    window.scrollTo({ top: 0, behavior: "smooth" });
    await sleep(500);
  });
}

/**
 * Record ONE shot's worth of the real product — about five seconds of it.
 *
 * Distinct from `captureProductDemo`, which records the whole page top to
 * bottom and IS the video. This produces a single take-length clip meant to be
 * cut in among generated shots, so that the one moment where accuracy actually
 * matters — the screen the narration is describing — shows the real interface
 * instead of a generative impression of one. No model can draw a product's UI
 * correctly, and none needs to when the real thing can be filmed.
 *
 * The scroll is slow and short on purpose: five seconds of gentle movement down
 * the hero reads as a camera move, where the full-page sweep reads as a page
 * being scrolled.
 */
export async function captureShotClip(input: {
  url: string;
  aspectRatio: AspectRatio;
  workspaceId: string;
  jobId: string;
  index: number;
  seconds?: number;
}): Promise<{ url: string; durationSec: number }> {
  const url = await assertPublicUrl(input.url);
  if (!url) throw new Error("Only public HTTP(S) URLs can be captured");
  const seconds = input.seconds ?? SEGMENT_SECONDS;
  const viewport = captureViewport(input.aspectRatio);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-shot-"));
  const browser = await launchBrowser();
  let videoBuffer: Buffer;
  try {
    const { context, page } = await createPublicCapturePage(browser, {
      viewport,
      recordVideo: { dir: tmpDir, size: viewport },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    await page
      .goto(url, { waitUntil: "networkidle", timeout: 45_000 })
      .catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }));
    await page.waitForTimeout(1_200);
    await dismissBanners(page);

    // A slow drift down the first screenful, for exactly the shot length.
    await page.evaluate(async (ms) => {
      const sleep = (n: number) => new Promise((r) => setTimeout(r, n));
      const steps = 20;
      const distance = Math.min(window.innerHeight * 0.8, document.body.scrollHeight);
      for (let i = 1; i <= steps; i++) {
        window.scrollTo({ top: (distance * i) / steps, behavior: "smooth" });
        await sleep(ms / steps);
      }
    }, seconds * 1000);

    await context.close(); // flushes the .webm
    const files = await fs.readdir(tmpDir);
    const webm = files.find((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("Playwright produced no recording");
    videoBuffer = await fs.readFile(path.join(tmpDir, webm));
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const db = createAdminClient();
  const storagePath = `${input.workspaceId}/${input.jobId}/shot-${input.index}.webm`;
  const up = await db.storage
    .from("videos")
    .upload(storagePath, videoBuffer, { contentType: "video/webm", upsert: true });
  if (up.error) throw new Error(`Shot upload failed: ${up.error.message}`);

  return {
    url: db.storage.from("videos").getPublicUrl(storagePath).data.publicUrl,
    durationSec: seconds,
  };
}

/**
 * Capture a product-demo clip of `url` and upload it. Throws on hard failure
 * (bad URL, navigation error, browser missing) so the caller can refund.
 */
export async function captureProductDemo(input: {
  url: string;
  aspectRatio: AspectRatio;
  workspaceId: string;
  jobId: string;
}): Promise<DemoCapture> {
  const url = await assertPublicUrl(input.url);
  if (!url) throw new Error("Only public HTTP(S) URLs can be captured");
  const viewport = captureViewport(input.aspectRatio);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-demo-"));
  const startedAt = Date.now();

  const browser = await launchBrowser();
  let videoBuffer: Buffer;
  let thumbnailBuffer: Buffer;
  let brandKit: BrandKit | undefined;
  try {
    const { context, page } = await createPublicCapturePage(browser, {
      viewport,
      recordVideo: { dir: tmpDir, size: viewport },
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    });
    const fontUrls = watchFontRequests(context);

    await page
      .goto(url, { waitUntil: "networkidle", timeout: 45_000 })
      .catch(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }));

    await page.waitForTimeout(1_500);
    await dismissBanners(page);
    thumbnailBuffer = await page.screenshot({ type: "png" });
    // Read the brand identity off the same page (best-effort) before scrolling.
    brandKit = await extractBrandKit(page, {
      workspaceId: input.workspaceId,
      slug: input.jobId,
      fontUrls,
    }).catch(() => undefined);
    await scrollThrough(page);
    await page.waitForTimeout(500);

    // Closing the context flushes the .webm to disk.
    await context.close();
    const files = await fs.readdir(tmpDir);
    const webm = files.find((f) => f.endsWith(".webm"));
    if (!webm) throw new Error("Playwright produced no recording");
    videoBuffer = await fs.readFile(path.join(tmpDir, webm));
  } finally {
    await browser.close().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const durationSec = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

  // Store both artifacts in the public `videos` bucket (service-role client).
  const db = createAdminClient();
  const base = `${input.workspaceId}/${input.jobId}`;
  const videoPath = `${base}.webm`;
  const thumbPath = `${base}-thumb.png`;

  const up = await db.storage
    .from("videos")
    .upload(videoPath, videoBuffer, { contentType: "video/webm", upsert: true });
  if (up.error) throw new Error(`Demo upload failed: ${up.error.message}`);
  await db.storage
    .from("videos")
    .upload(thumbPath, thumbnailBuffer, { contentType: "image/png", upsert: true });

  return {
    url: db.storage.from("videos").getPublicUrl(videoPath).data.publicUrl,
    thumbnailUrl: db.storage.from("videos").getPublicUrl(thumbPath).data.publicUrl,
    durationSec,
    brandKit,
  };
}
