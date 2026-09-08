/**
 * Brand palette: deduplicate what the scraper saw, then say what each colour IS.
 *
 * The scanner reads every computed background and foreground on the page and
 * tallies them. That produces a list with two problems.
 *
 * First, it is full of near-duplicates. A page whose sections are #0d0d0d,
 * #0e0e0e and #111111 hands back three "brand colours" that no human can tell
 * apart, and because the palette is capped at six entries those three crowd out
 * the colours that actually identify the brand. Exact-hex dedupe (what this
 * replaces) cannot see that they are the same colour.
 *
 * Second, an undifferentiated list cannot be used. "Here are six hex codes" is
 * not something an end card can lay out — it needs to know which one is the
 * background, which one is safe to put text in, and which one is the brand.
 *
 * So: collapse by PERCEPTUAL distance (CIE Lab ΔE, not RGB distance — RGB
 * distance says #000080 and #008000 are close), then assign roles.
 *
 * Deliberately never invents a colour. A brand with one accent gets one accent;
 * fabricating a second from a hue rotation would put a colour on the user's
 * video that appears nowhere on their site.
 */

/** Parse #rgb / #rrggbb into 0-255 components. Null for anything else. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const s = hex.trim().toLowerCase();
  const long = s.match(/^#([0-9a-f]{6})$/);
  if (long) {
    const n = parseInt(long[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const short = s.match(/^#([0-9a-f]{3})$/);
  if (short) {
    const [r, g, b] = short[1].split("");
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16)];
  }
  return null;
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** sRGB channel (0-255) to linear light (0-1). */
function linearize(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * WCAG relative luminance. Used both for contrast and for deciding whether a
 * colour reads as "a light surface" or "a dark surface".
 */
export function luminance(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map(linearize);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours: 1 (identical) to 21 (black/white). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE Lab, D65. The space ΔE is defined in. */
function toLab(hex: string): [number, number, number] {
  const rgb = hexToRgb(hex);
  if (!rgb) return [0, 0, 0];
  const [r, g, b] = rgb.map(linearize);
  // linear sRGB -> XYZ (D65)
  const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047;
  const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175;
  const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Perceptual distance (CIE76). Roughly: <2.3 is invisible to most people,
 * ~10 is "clearly a different shade", >30 is "a different colour".
 */
export function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** HSL saturation, 0-1. */
function saturation(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return 0;
  const d = max - min;
  return l > 0.5 ? d / (2 - max - min) : d / (max + min);
}

/** Absolute chroma: the channel spread, 0-255. */
function chroma(hex: string): number {
  const rgb = hexToRgb(hex);
  if (!rgb) return 0;
  return Math.max(...rgb) - Math.min(...rgb);
}

/**
 * A colour with no meaningful hue — white, black, and the greys between.
 *
 * BOTH tests are needed, and each one alone is wrong in a way this palette
 * cares about.
 *
 * HSL saturation alone fails at the extremes, because its denominator collapses
 * near white and near black: #f6f8fa is four units of channel spread at 97%
 * lightness and scores 0.28 saturation — so a page's off-white background
 * reported as a brand accent, which is precisely the "six greys" failure this
 * module exists to prevent.
 *
 * Absolute chroma alone fails in the middle: a spread of 24 units is nothing on
 * a bright colour and a real hue on a dark one, so a single threshold either
 * admits every off-white or rejects mid-tones that plainly have a colour.
 *
 * The pair draws the line about where a person would. #0a2540 (chroma 54) is a
 * brand navy and survives; #202030 (chroma 16) is a blue-tinted near-black —
 * a surface, not a brand colour — and is correctly called neutral.
 *
 * So: neutral if the channels barely differ at all, OR if what difference there
 * is does not amount to a hue.
 */
export function isNeutral(hex: string): boolean {
  return chroma(hex) < 24 || saturation(hex) < 0.12;
}

/**
 * How strongly a colour reads as "the brand colour" rather than as a surface.
 * Saturated mid-tones win; near-white and near-black lose regardless of hue.
 */
function brandiness(hex: string): number {
  const l = luminance(hex);
  const sat = saturation(hex);
  // Peaks around mid luminance — a brand colour you can put white text on.
  const midness = 1 - Math.abs(l - 0.3) / 0.7;
  return sat * Math.max(0, midness);
}

/**
 * Collapse visually identical colours, keeping the first occurrence of each
 * cluster. Order is significant: callers pass colours most-important-first, and
 * the survivor of a cluster is the earliest member.
 */
export function dedupeColors(colors: string[], threshold = 10): string[] {
  const out: string[] = [];
  for (const raw of colors) {
    const c = raw?.trim().toLowerCase();
    if (!c || !hexToRgb(c)) continue;
    if (out.some((kept) => deltaE(kept, c) < threshold)) continue;
    out.push(c);
  }
  return out;
}

export interface ClassifiedPalette {
  /** The brand colour: buttons, links, the thing people picture. */
  primary?: string;
  /** A second brand colour, distinct from primary. Absent when there isn't one. */
  accent?: string;
  /** The page's dominant surface. */
  background?: string;
  /** Body copy colour, guaranteed readable on `background` when possible. */
  text?: string;
  /** Deduped palette, primary-first, for prompts and swatches. */
  colors: string[];
}

export interface PaletteInput {
  /** Background colours of buttons/CTAs, most frequent first. */
  buttonColors?: (string | null | undefined)[];
  /** <meta name="theme-color">. */
  themeColor?: string | null;
  /** Colours declared as CSS custom properties on :root. */
  varColors?: (string | null | undefined)[];
  /** Page background colours, most frequent first. */
  backgrounds?: (string | null | undefined)[];
  /** Text colours, most frequent first. */
  foregrounds?: (string | null | undefined)[];
}

/** Keep only parseable hex, preserving order. */
function clean(list: (string | null | undefined)[] | undefined): string[] {
  return (list ?? [])
    .map((c) => c?.trim().toLowerCase() ?? "")
    .filter((c) => !!c && !!hexToRgb(c));
}

/** Minimum contrast for body text. WCAG AA for normal text. */
const READABLE_CONTRAST = 4.5;

/**
 * Assign roles to what the scanner saw.
 *
 * The order of preference for PRIMARY encodes what a brand colour actually is:
 * the colour of the thing you are meant to click, then the colour the site
 * declares to the OS, then a colour it named in its own design tokens, then the
 * most brand-like saturated colour anywhere on the page.
 */
export function classifyPalette(input: PaletteInput): ClassifiedPalette {
  const buttons = clean(input.buttonColors);
  const vars = clean(input.varColors);
  const backgrounds = clean(input.backgrounds);
  const foregrounds = clean(input.foregrounds);
  const theme = clean([input.themeColor])[0];

  const saturated = (list: string[]) => list.filter((c) => !isNeutral(c));

  const primary =
    saturated(buttons)[0] ??
    (theme && !isNeutral(theme) ? theme : undefined) ??
    // Among declared design tokens, the most brand-like rather than the first:
    // token order is authoring order and says nothing about importance.
    saturated(vars).sort((a, b) => brandiness(b) - brandiness(a))[0] ??
    saturated(backgrounds).sort((a, b) => brandiness(b) - brandiness(a))[0] ??
    saturated(foregrounds).sort((a, b) => brandiness(b) - brandiness(a))[0];

  // The dominant surface. Most sites' most-common background IS the page
  // background, and that is what the tally already orders by.
  const background = backgrounds[0];

  // Body text: the most common foreground that can actually be read on the
  // background. Falling back to the most common one regardless keeps a value
  // for brands whose own site fails contrast — their choice, not ours to fix.
  const text =
    (background
      ? foregrounds.find((c) => contrastRatio(c, background) >= READABLE_CONTRAST)
      : undefined) ?? foregrounds[0];

  // Accent: the next brand colour that is genuinely a different colour from
  // primary, drawn from every saturated candidate we have. Never fabricated.
  const accentPool = dedupeColors(
    [...saturated(buttons), ...saturated(vars), ...saturated(backgrounds), ...saturated(foregrounds)],
  );
  const accent = primary
    ? accentPool.find((c) => deltaE(c, primary) >= 25)
    : accentPool[1];

  // The ordered palette. Role colours lead so a consumer that takes the first
  // three gets primary/accent/background rather than three greys.
  const colors = dedupeColors([
    ...(primary ? [primary] : []),
    ...(accent ? [accent] : []),
    ...(background ? [background] : []),
    ...(text ? [text] : []),
    ...saturated(vars),
    ...backgrounds,
    ...foregrounds,
  ]).slice(0, 6);

  return { primary, accent, background, text, colors };
}

/**
 * Pick the more readable of black/white for text sitting on `bg`, or use the
 * brand's own text colour when it clears the bar. Used by the end card, where
 * illegible brand-on-brand text is a real risk.
 */
export function readableOn(bg: string, preferred?: string): string {
  if (preferred && contrastRatio(preferred, bg) >= READABLE_CONTRAST) return preferred;
  return contrastRatio("#ffffff", bg) >= contrastRatio("#000000", bg) ? "#ffffff" : "#000000";
}
