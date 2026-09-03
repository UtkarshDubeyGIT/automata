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
