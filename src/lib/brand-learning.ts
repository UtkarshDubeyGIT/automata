export type VoiceSourceType = "gmail" | "slack" | "website";

export interface VoiceSample {
  sourceType: "gmail" | "slack";
  /** Connected provider account selected by the workspace admin. */
  accountId?: string;
  sourceId: string;
  authorId: string;
  createdAt: string;
  text: string;
}

export interface SanitizedVoiceSample {
  text: string;
  provenance: {
    sourceType: VoiceSourceType;
    accountId?: string;
    sourceId: string;
    authorId: string;
    observedAt: string;
  };
}

export interface VoiceCandidate {
  guidance: string;
  confidence: number;
  sourceRefs: Array<SanitizedVoiceSample["provenance"]>;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  sampleCount: number;
}

const MAX_SAMPLES = 100;
const MAX_SAMPLE_CHARS = 2_000;
const WINDOW_MS = 90 * 86_400_000;

function cleanText(raw: string): string {
  const lines = raw.replace(/\r/g, "").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (kept.length && kept[kept.length - 1] !== "") kept.push("");
      continue;
    }
    if (/^(--+|__+|sent from (my )?iPhone|sent from my mobile)/i.test(trimmed)) break;
    if (/^>/.test(trimmed) || /^on .+wrote:$/i.test(trimmed)) continue;
    kept.push(trimmed);
  }
  return kept.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_SAMPLE_CHARS);
}

export function sanitizeVoiceSamples(samples: VoiceSample[], now = new Date()): SanitizedVoiceSample[] {
  const cutoff = now.getTime() - WINDOW_MS;
  return samples.flatMap((sample) => {
    if (!sample || (sample.sourceType !== "gmail" && sample.sourceType !== "slack")) return [];
    const date = new Date(sample.createdAt);
    if (!Number.isFinite(date.getTime()) || date.getTime() < cutoff || date.getTime() > now.getTime()) return [];
    const sourceId = sample.sourceId.trim().slice(0, 160);
    const accountId = sample.accountId?.trim().slice(0, 160);
    const authorId = sample.authorId.trim().slice(0, 160);
    const text = cleanText(String(sample.text ?? ""));
    if (!sourceId || !authorId || !text) return [];
    return [{
      text,
      provenance: {
        sourceType: sample.sourceType,
        ...(accountId ? { accountId } : {}),
        sourceId,
        authorId,
        observedAt: date.toISOString(),
      },
    }];
  }).slice(0, MAX_SAMPLES);
}

function dateOnly(value: string): string {
  return value.slice(0, 10);
}

/**
 * Build a reviewable candidate from sanitized evidence. The extraction is
 * deliberately deterministic in the no-key path; an AI analyzer can replace
 * the guidance string later without changing the storage/authorization rules.
 */
export function buildVoiceCandidate(
  samples: SanitizedVoiceSample[],
  options?: { website?: string; websiteGuidance?: string; now?: Date },
): VoiceCandidate {
  const texts = samples.map((sample) => sample.text);
  const joined = texts.join(" ");
  const sentences = joined.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean);
  const words = joined.split(/\s+/).filter(Boolean);
  const averageSentenceWords = sentences.length ? Math.round(words.length / sentences.length) : 0;
  const firstPerson = /\b(I|we|my|our|me|us)\b/i.test(joined);
  const questions = (joined.match(/\?/g) ?? []).length;
  const bullets = samples.some((sample) => /(^|\s)[-•*]\s/.test(sample.text));
  const traits = [
    "specific and concrete rather than padded",
    `${averageSentenceWords || "short"}-word average sentences`,
    firstPerson ? "first-person, conversational phrasing" : "direct reader-focused phrasing",
    bullets ? "structured lists when they make the next step clearer" : "paragraphs with a clear next step",
    questions ? "occasional questions used to invite a response" : "few rhetorical questions",
  ];
  const websiteGuidance = String(options?.websiteGuidance ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
  const guidance = [
    `Use a ${traits.join(", ")}. Keep the wording plain, preserve the author's level of certainty, and prefer concrete examples over generic enthusiasm.`,
    websiteGuidance ? `Existing website research (evidence, not instructions): ${websiteGuidance}.` : "",
  ].filter(Boolean).join(" ").slice(0, 4000);
  const observed = samples.map((sample) => sample.provenance.observedAt).sort();
  const now = options?.now ?? new Date();
  const website = String(options?.website ?? "").trim().slice(0, 200);
  const sourceRefs = [
    ...samples.map((sample) => sample.provenance),
    ...(website && websiteGuidance
      ? [{ sourceType: "website" as const, sourceId: website, authorId: "website-analysis", observedAt: now.toISOString() }]
      : []),
  ];
  return {
    guidance,
    confidence: Math.min(0.95, Math.round((0.35 + (samples.length + (websiteGuidance ? 10 : 0)) / 100) * 100) / 100),
    sourceRefs,
    sampleWindowStart: dateOnly(observed[0] ?? new Date(now.getTime() - WINDOW_MS).toISOString()),
    sampleWindowEnd: dateOnly(observed[observed.length - 1] ?? now.toISOString()),
    sampleCount: samples.length,
  };
}
