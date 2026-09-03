import type { CarouselSlide } from "@/lib/ai/content";

/**
 * Slides → PDF, which is the only shape LinkedIn accepts for a carousel.
 *
 * A LinkedIn carousel is a "document post": one PDF whose pages become the
 * swipeable cards. There is no multi-image carousel endpoint for members, so
 * rendering is not a nicety here — it is the whole difference between a
 * carousel and a wall of text with slide numbers in it.
 *
 * Chromium is already a dependency (the video pipeline and the QA harness both
 * drive it), so the render goes through Playwright rather than pulling in a PDF
 * toolkit that would have to reimplement text wrapping and web fonts.
 */

/** Square. Portrait reads taller in feed but crops badly in the preview tile. */
const SIDE_PX = 1080;

export interface CarouselBrand {
  company?: string | null;
  /** Hex, with or without the leading '#'. Falls back to the product accent. */
  accent?: string | null;
}

/**
 * Escape before interpolation. Slide copy is model-generated and can contain
 * anything; an unescaped `<` would silently break the page it is drawn into.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeHex(v: string | null | undefined, fallback: string): string {
  const raw = (v ?? "").trim().replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(raw) ? `#${raw}` : fallback;
}

export function carouselHtml(slides: CarouselSlide[], brand: CarouselBrand = {}): string {
  const accent = normalizeHex(brand.accent, "#4f46e5");
  const company = (brand.company ?? "").trim();
  const total = slides.length;

  const pages = slides
    .map((s, i) => {
      const heading = esc((s.heading ?? "").trim());
      const body = esc((s.body ?? "").trim());
      // The hook slide is set larger and carries no body — it has one job.
      const isHook = i === 0;
      return `
      <section class="slide${isHook ? " hook" : ""}">
        <div class="rule"></div>
        <div class="content">
          <h1>${heading}</h1>
          ${body ? `<p>${body}</p>` : ""}
        </div>
        <footer>
          <span class="brand">${esc(company)}</span>
          <span class="page">${i + 1} / ${total}</span>
        </footer>
      </section>`;
    })
    .join("\n");

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  @page { size: ${SIDE_PX}px ${SIDE_PX}px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .slide {
    width: ${SIDE_PX}px; height: ${SIDE_PX}px;
    /* Every page must start a new PDF page, or the whole deck renders as one. */
    page-break-after: always; break-after: page;
    position: relative; display: flex; flex-direction: column;
    justify-content: center;
    padding: 96px 88px; background: #0b0f19; color: #f8fafc;
    overflow: hidden;
  }
  .slide:last-child { page-break-after: auto; break-after: auto; }
  .rule { position: absolute; top: 0; left: 0; width: 100%; height: 14px; background: ${accent}; }
  .content { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 34px; }
  h1 { font-size: 74px; line-height: 1.1; font-weight: 700; letter-spacing: -0.02em; }
  .hook h1 { font-size: 96px; }
  p { font-size: 38px; line-height: 1.45; color: #cbd5e1; font-weight: 400; }
  footer {
    position: absolute; left: 88px; right: 88px; bottom: 64px;
    display: flex; justify-content: space-between; align-items: center;
    font-size: 26px; color: #64748b;
  }
  .brand { font-weight: 600; color: ${accent}; }
</style></head>
<body>${pages}</body></html>`;
}

/**
 * Render to PDF bytes.
 *
 * Chromium is launched per render and closed in `finally`. Carousels are
 * produced a handful of times a day at most, so a pooled browser would be
 * holding ~150MB resident for something that runs for two seconds.
 */
export async function renderCarouselPdf(
  slides: CarouselSlide[],
  brand: CarouselBrand = {},
): Promise<Buffer> {
  if (!slides.length) throw new Error("Cannot render a carousel with no slides");

  // Imported lazily: this module is reachable from the publish path, and
  // Playwright must not be pulled into a bundle that never renders anything.
  // @ts-expect-error optional playwright dependency
  const { chromium } = await import("playwright");

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({
      viewport: { width: SIDE_PX, height: SIDE_PX },
    });
    await page.setContent(carouselHtml(slides, brand), { waitUntil: "load" });
    return await page.pdf({
      width: `${SIDE_PX}px`,
      height: `${SIDE_PX}px`,
      printBackground: true,
      pageRanges: `1-${slides.length}`,
    });
  } finally {
    await browser.close();
  }
}
