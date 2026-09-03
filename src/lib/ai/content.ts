import { chatJSON } from "./openai";

/**
 * Formats, tones and their labels live in `./content-vocabulary`, which has no
 * OpenAI client and no `env` — a picker in the browser can read them without
 * pulling this module in. Re-exported because every caller reaches for them
 * here.
 */
export {
  CONTENT_TONES,
  TONE_LABEL,
  type ContentFormat,
  type ContentTone,
} from "./content-vocabulary";
import { FORMAT_LABEL, TONE_LABEL, type ContentFormat, type ContentTone } from "./content-vocabulary";

export interface ContentVariation {
  text: string;
  viralScore: number;
}

/** Generate N on-brand content variations. Falls back to samples w/o a key. */
export async function generateVariations(input: {
  topic: string;
  format: ContentFormat;
  tone: ContentTone;
  virality: number; // 0-100
  count?: number;
  /** Workspace brand context block from brandContext() — "" when absent. */
  brand?: string;
}): Promise<ContentVariation[]> {
  const count = input.count ?? 3;
  const hasBrand = !!input.brand?.trim();
  // When a brand profile exists it is AUTHORITATIVE — the content must sound
  // like that brand, not like a fixed house style. Only fall back to a generic
  // copywriter voice when no brand context is available.
  const system = `You are an expert growth copywriter producing content on behalf of a specific brand.
${
  hasBrand
    ? `${input.brand}
The BRAND CONTEXT above is authoritative. Write in THIS brand's voice, about THIS product and audience, using its own vocabulary and formatting conventions (emoji, capitalization, hashtags, sentence length). Every variation must be specific to this brand — never generic, and never about a tool called "ZidaneAI".`
    : `Voice: confident, plain-spoken, founder-to-founder. Lead with concrete specifics and outcomes.`
}
Write ${FORMAT_LABEL[input.format]}. Layer a ${TONE_LABEL[input.tone]} tone on top WITHOUT overriding the brand's own voice.
Virality target: ${input.virality}/100 (higher = punchier, more contrarian hooks).
Return strict JSON: {"variations":[{"text":"...","viralScore":0-100}]} with exactly ${count} variations.`;

  const user = input.topic?.trim()
    ? `Topic: ${input.topic}`
    : "Topic: why solo founders can now replace an entire growth team with AI agents";

  try {
    const out = await chatJSON<{ variations: ContentVariation[] }>(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.9, maxTokens: 1400 },
    );
    if (out?.variations?.length) return out.variations.slice(0, count);
  } catch {
    // fall through to samples
  }
  return sampleVariations(count);
}

function sampleVariations(count: number): ContentVariation[] {
  const base: ContentVariation[] = [
    {
      text: "Solo founders aren't lonely anymore.\n\nThey have a team of AI agents working 24/7.\n\nDesign. Code. Marketing. Growth.\n\nThe billion-dollar one-person company isn't a meme. It's already shipping.",
      viralScore: 94,
    },
    {
      text: "5 years ago: hire 50 people, raise $10M, hope it works.\n\nToday: build a product solo with AI, get to $1M ARR in 6 months.\n\nDistribution is the last moat. Automate it.",
      viralScore: 87,
    },
    {
      text: "Your growth team is now four agents that never sleep.\n\nOne writes. One clips video. One studies trends. One ships.\n\nYou approve. They execute.",
      viralScore: 82,
    },
  ];
  return base.slice(0, count);
}

// ---------------------------------------------------------------------------
// Carousels
// ---------------------------------------------------------------------------

/**
 * One slide of a carousel. Carousels are the highest-reach format on LinkedIn
 * and Instagram, and they are STRUCTURED — a flat block of text cannot be
 * posted as one. So this is generated and stored as slides, not prose.
 */
export interface CarouselSlide {
  /** Big line on the slide. Short — it is set at display size. */
  heading: string;
  /** Optional supporting line. Empty on hook/CTA slides more often than not. */
  body: string;
}

export interface CarouselVariation {
  slides: CarouselSlide[];
  /** Flattened, human-readable rendering — what gets stored in `body`. */
  text: string;
  viralScore: number;
}

/** Slides outside this range stop reading as a carousel. */
const MIN_SLIDES = 3;
const MAX_SLIDES = 10;

/** "1 / 7  HEADING\n  body" — the text form stored alongside the slides. */
export function renderCarousel(slides: CarouselSlide[]): string {
  return slides
    .map((s, i) => {
      const head = `${i + 1} / ${slides.length}  ${s.heading}`;
      return s.body?.trim() ? `${head}\n${s.body.trim()}` : head;
    })
    .join("\n\n");
}

/**
 * Generate carousel variations as real slides.
 *
 * Kept separate from `generateVariations` because that function's contract is
 * "a string per variation", and squeezing slides into it would mean parsing
 * prose back into structure at every call site.
 */
export async function generateCarousel(input: {
  topic: string;
  tone: ContentTone;
  virality: number;
  /** Requested slide count; clamped to a postable range. */
  slideCount?: number;
  count?: number;
  brand?: string;
}): Promise<CarouselVariation[]> {
  const count = input.count ?? 1;
  const slideCount = Math.min(MAX_SLIDES, Math.max(MIN_SLIDES, input.slideCount ?? 7));
  const hasBrand = !!input.brand?.trim();

  const system = `You are an expert growth copywriter producing a carousel on behalf of a specific brand.
${
  hasBrand
    ? `${input.brand}
The BRAND CONTEXT above is authoritative. Write in THIS brand's voice, about THIS product and audience.`
    : `Voice: confident, plain-spoken, founder-to-founder. Lead with concrete specifics and outcomes.`
}
Layer a ${TONE_LABEL[input.tone]} tone on top WITHOUT overriding the brand's own voice.
Virality target: ${input.virality}/100 (higher = punchier, more contrarian hooks).

Rules for the carousel:
- Exactly ${slideCount} slides.
- Slide 1 is the hook: a single claim that stops the scroll. No body text.
- Middle slides carry ONE idea each. Heading under 60 characters; body under 180.
- The last slide is a call to action.
- Headings are read at display size — they must work as standalone lines.
- No slide numbers in the text (they are rendered separately), no markdown, no emoji unless the brand uses them.

Return strict JSON: {"variations":[{"slides":[{"heading":"...","body":"..."}],"viralScore":0-100}]} with exactly ${count} variation(s).`;

  const user = input.topic?.trim() ? `Topic: ${input.topic}` : "Topic: what a solo founder can automate first";

  try {
    const out = await chatJSON<{
      variations: { slides?: CarouselSlide[]; viralScore?: number }[];
    }>(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: 0.9, maxTokens: 1800 },
    );

    const variations = (out?.variations ?? [])
      .map((v) => {
        const slides = (v.slides ?? [])
          .filter((s) => s && typeof s.heading === "string" && s.heading.trim())
          .slice(0, MAX_SLIDES)
          .map((s) => ({
            heading: String(s.heading).trim().slice(0, 120),
            body: String(s.body ?? "").trim().slice(0, 400),
          }));
        return { slides, viralScore: Math.round(Number(v.viralScore) || 0) };
      })
      // A "carousel" of one slide is a post. Drop anything that short rather
      // than storing it as a carousel the user cannot actually publish.
      .filter((v) => v.slides.length >= MIN_SLIDES)
      .map((v) => ({ ...v, text: renderCarousel(v.slides) }));

    if (variations.length) return variations.slice(0, count);
  } catch {
    // fall through
  }
  return sampleCarousel(count);
}

function sampleCarousel(count: number): CarouselVariation[] {
  const slides: CarouselSlide[] = [
    { heading: "You don't need a growth team. You need a growth system.", body: "" },
    { heading: "Most founders automate the wrong thing first", body: "They automate posting before they know what works. Distribution without a signal is just noise on a schedule." },
    { heading: "Start with the measurement", body: "You cannot compound what you cannot see. One connected analytics source beats ten scheduled posts." },
    { heading: "Then automate the research", body: "Trends and hooks are the cheapest thing to run daily and the most expensive thing to skip." },
    { heading: "Automate creation last", body: "Once you know the angle, generating the asset is the easy part." },
    { heading: "What would you automate first?", body: "Reply below — I read every one." },
  ];
  return Array.from({ length: count }, () => ({
    slides,
    text: renderCarousel(slides),
    viralScore: 88,
  }));
}
