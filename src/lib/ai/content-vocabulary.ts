export type ContentFormat =
  | "tweet"
  | "thread"
  | "linkedin"
  | "caption"
  | "hook"
  | "adcopy"
  | "cta"
  | "videoscript"
  | "carousel"
  | "email";

export type ContentTone =
  | "professional"
  | "viral"
  | "educational"
  | "bold"
  | "founder";

export const FORMAT_LABEL: Record<ContentFormat, string> = {
  tweet: "a single punchy tweet",
  thread: "an X thread (5-8 short posts, one per line group)",
  linkedin: "a LinkedIn post",
  caption: "a short social caption",
  hook: "3 scroll-stopping opening hooks",
  adcopy: "ad copy with a headline and body",
  cta: "a call-to-action line",
  videoscript: "a 30-second short-form video script",
  carousel: "a LinkedIn carousel — a hook slide, then one idea per slide, then a CTA slide",
  email: "a lifecycle or outreach email with a subject line on the first line, then the body",
};

export const CONTENT_TONES: readonly ContentTone[] = [
  "professional",
  "viral",
  "educational",
  "bold",
  "founder",
] as const;

export const TONE_LABEL: Record<ContentTone, string> = {
  professional: "polished and professional",
  viral: "optimized for maximum shares and virality",
  educational: "clear and educational",
  bold: "bold, contrarian, and opinionated",
  founder: "founder-to-founder, plain-spoken, and confident",
};

/**
 * Formats that are a post an audience reads, rather than a component.
 *
 * Only used to decide whether the house style's "end on a real question" rule
 * applies (see `./humanize`). Ending a `cta` line or a set of `hook` openers on
 * a question is incoherent — they are fragments meant to be placed inside
 * something else — and an `email` closes with a sign-off, not an engagement
 * prompt.
 */
const AUDIENCE_FORMATS = new Set<ContentFormat>([
  "tweet",
  "thread",
  "linkedin",
  "caption",
  "carousel",
]);

export function isAudienceFormat(format: ContentFormat): boolean {
  return AUDIENCE_FORMATS.has(format);
}
