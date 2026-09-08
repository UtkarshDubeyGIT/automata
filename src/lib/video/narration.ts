import fs from "node:fs/promises";
import { env } from "@/lib/env";
import type { VideoKind } from "@/lib/video/higgsfield";
import { specForKind } from "@/lib/video/higgsfield";
import { probeDuration } from "@/lib/video/probe";
import type { BrandProfile } from "@/lib/brand";
import { brandContext, narrationLanguage } from "@/lib/brand";
import { CONTENT_TONES, TONE_LABEL, type ContentTone } from "@/lib/ai/content";
import { repairTerms } from "@/lib/brand/canonical";

/**
 * The words half of post-production: writing the narration, speaking it, and
 * making it fit.
 *
 * This is the first of the three stages `addVoiceover` runs (words → picture →
 * branding), split out of `postproduce.ts` because it is the one with no ffmpeg
 * in it. Everything here is a model call and a word count; the only file it
 * touches is the mp3 it writes so the length can be MEASURED rather than
 * estimated. That measurement is the whole design — see `narrationWithinBudget`
 * — and it is why this stage cannot be a pure function of the script text.
 *
 * The stages are deliberately not a generic pipeline of interchangeable filters:
 * each one hands the next something specific (the CTA this stage writes becomes
 * the end card, whose height decides where the captions stop), and a shared
 * mutable bag passed down a chain would hide exactly the dependencies that make
 * the order matter.
 */

/** OpenAI TTS voice used for every narration. */
export const VOICEOVER_VOICE = "nova";

/**
 * How each tone should be PERFORMED, as opposed to written.
 *
 * Tone reached the script writer and stopped there, so picking "bold" changed
 * roughly forty words and nothing else: the same voice read them at the same
 * pace with the same delivery, and the difference was inaudible to anyone who
 * had not read both scripts side by side. `gpt-4o-mini-tts` takes an
 * `instructions` field for exactly this, so the choice now steers the read as
 * well as the wording — which is what someone picking a tone is asking for.
 *
 * Deliberately about delivery only (pace, energy, attitude). The words are
 * already handled by `writeScript`, and repeating the content instruction here
 * just fights it.
 */
const TONE_DELIVERY: Record<ContentTone, string> = {
  professional: "Measured and composed. Even pace, clear articulation, warm but restrained.",
  viral: "High energy and fast. Punch the opening words, keep the momentum up, sound excited.",
  educational: "Calm and clear. Slightly slower than conversational, landing each point deliberately.",
  bold: "Direct and confident, with edge. Lean into the strong words and leave a beat after them.",
  founder: "Conversational and plain-spoken, like talking to one person across a table. Unpolished, sincere.",
};

/**
 * WHO is speaking, per video type.
 *
 * Every type used to get the same instruction — "voiceover narration for short
 * marketing videos" — which is the right frame for exactly one of them. A UGC
 * ad is a person holding a phone telling you what they think of something they
 * bought; narrating it in brand-announcer third person is the single thing that
 * most reliably makes a UGC ad read as an ad. The picture is already shot as a
 * selfie (see the `ugc` keyframe spec); the voice has to match it.
 */
const NARRATION_PERSPECTIVE: Record<VideoKind, string> = {
  ugc:
    "Write it as the PERSON ON CAMERA, speaking about their own experience in " +
    "first person — I, me, my. Present tense, talking to a friend who asked. " +
    "No slogans, no brand-announcer voice, never refer to the product in the " +
    "third person as a company would. Contractions and plain words only.",
  shortform:
    "Write it as a creator addressing the viewer directly — you, your. Short " +
    "declarative sentences. The first line has to earn the second.",
  cinematic:
    "Write it as a spare brand voice over pictures. Few words, high conviction, " +
    "nothing explained that the footage already shows.",
  avatar:
    "Write it as a presenter speaking straight to the viewer — clear, warm, " +
    "second person.",
  demo:
    "Write it as a guide walking the viewer through the screen — second person, " +
    "concrete, naming what is on screen as it appears.",
};

/**
 * Delivery direction for the chosen tone, or a neutral read when none was set.
 * The type steers the performance too: the same words read as a polished
 * announcement or as someone talking to their phone are different products.
 */
export function deliveryFor(tone: ContentTone | null | undefined, kind: VideoKind): string {
  const base =
    kind === "ugc"
      ? "Read this as a real person talking into their own phone camera — not a " +
        "voice actor, not an advert. Slightly uneven pacing, natural breaths, " +
        "warm and unpolished."
      : "Read as voiceover narration for a short brand video. Natural, never robotic.";
  return tone ? `${base} ${TONE_DELIVERY[tone]}` : base;
}

const TTS_MODEL = "gpt-4o-mini-tts";
const SCRIPT_MODEL = "gpt-4o";

/**
 * Spoken-word pace used to size the script to the clip. Measured against the
 * `nova` voice reading real generated scripts (~1.8 w/s), not a generic
 * speech-rate figure — overestimating here gets the tail of the read cut off.
 */
const WORDS_PER_SECOND = 1.9;

/**
 * Most the narration may be sped up to fit the picture.
 *
 * This was 1.25x, on the reasoning that listeners do not notice up to about
 * there. They do — 1.25x is the speed people deliberately choose for podcasts,
 * and a "warm, unpolished" UGC read played at podcast-skim speed stops sounding
 * like a person and starts sounding like a machine reading fast. Worse, tempo
 * was doing the work that belonged to the WORDS: a script 25% too long is not a
 * playback problem, it is a script that needs to be shorter.
 *
 * So the budget is enforced by rewriting (see `narrationWithinBudget`) and this
 * is only the crumb of stretch that absorbs a read landing a beat long.
 */
export const MAX_TEMPO = 1.06;

/**
 * How many times a too-long script is rewritten shorter before we accept it.
 *
 * Each attempt is one GPT call plus one TTS render, so this is bounded tightly.
 * Two is enough in practice: the rewrite is given the measured overshoot, so it
 * is correcting against a real number rather than guessing again.
 */
const SCRIPT_REWRITES = 2;

/** Per-stage ceilings for the two provider calls this stage makes. */
const SCRIPT_TIMEOUT_MS = 60_000;
const TTS_TIMEOUT_MS = 120_000;

/** One narration draft: what is said, and what the end card asks for. */
export interface ScriptDraft {
  script: string;
  /** Imperative line for the end card. May be empty — the card copes. */
  cta: string;
}

/**
 * Write the narration. The word budget is derived from the real clip length so
 * the read lands inside the video instead of being cut off mid-sentence.
 */
export async function writeScript(input: {
  prompt: string;
  kind: VideoKind;
  seconds: number;
  profile?: BrandProfile | null;
  /**
   * Tone for THIS clip, layered over the brand's own voice. Undefined is the
   * normal case, not a gap: the model then picks the tone that best serves the
   * concept, which is what "the agent decides" means here.
   */
  tone?: ContentTone | null;
  /**
   * A previous draft that came in too long, and the word budget it must hit
   * this time. Rewriting beats re-rolling: the model keeps what worked and cuts,
   * rather than producing an unrelated script that may also overrun.
   */
  shorten?: { previous: string; targetWords: number };
}): Promise<ScriptDraft> {
  const words = input.shorten
    ? input.shorten.targetWords
    : Math.max(6, Math.round(input.seconds * WORDS_PER_SECOND));
  const spec = specForKind(input.kind);
  const p = input.profile;
  // Pinned, never inferred. The brand dossier is full of proper nouns and
  // copy in whatever language the site is written in, and without an explicit
  // instruction the model would follow that instead of the user's language.
  const language = narrationLanguage(p);
  // The same dossier every other generator writes from — so a clip sounds like
  // the brand's blog posts and ads do. This used to be five hand-picked fields,
  // which is why narration ignored the tone, the on-brand vocabulary and the
  // writing rules the user typed into Settings: none of them were in the list.
  // Research is excluded (see brandContext): competitor and objection intel
  // does not earn its words in a thirty-second read.
  const brand = brandContext(p ?? null, { includeResearch: false });

  // The brand's voice is the floor and is never overridden — a tone is a layer
  // on top of it, exactly as Content Studio applies one. Chosen by the caller
  // when the user picked one or an agent decided; otherwise the model chooses,
  // because the right tone depends on the concept and the format, not on the
  // company. Naming the menu keeps that choice inside the same vocabulary the
  // rest of the product uses instead of inventing a sixth tone per clip.
  const toneLine = input.tone
    ? `Layer a ${TONE_LABEL[input.tone]} tone on top WITHOUT overriding the brand's own voice.`
    : `Choose the tone that will make THIS concept land best in this format — one of: ` +
      `${CONTENT_TONES.map((t) => TONE_LABEL[t]).join("; ")}. ` +
      `Layer it on top WITHOUT overriding the brand's own voice.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: SCRIPT_MODEL,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You write voiceover for short marketing videos.\n" +
            'Return STRICT JSON: {"script": "...", "cta": "..."}.\n' +
            "`script` is ONLY the words to be spoken — no scene directions, no " +
            "speaker labels, no quotation marks, no emoji, no markdown, " +
            "sentence case, natural read aloud.\n" +
            "`cta` is the call to action for the END CARD, not something spoken: " +
            "at most five words, imperative, title case, no punctuation, no URL " +
            '(e.g. "Start free today", "Book a demo").\n' +
            `Write both in ${language}, and in ${language} only. ` +
            "This is absolute: ignore the language of the brand details, the " +
            "product name or the video concept below — they are context, not " +
            `a language instruction. Every word must be ${language}, ` +
            "apart from proper nouns that have no translation.",
        },
        {
          role: "user",
          content: input.shorten
            ? `This voiceover runs too long. Rewrite it to about ${words} words, ` +
              `keeping the strongest line and the same meaning. It must be ` +
              `speakable in ${input.seconds.toFixed(1)} seconds at an unhurried pace.\n\n` +
              `Too-long draft:\n${input.shorten.previous}\n\n` +
              `${NARRATION_PERSPECTIVE[input.kind]}\nWrite it in ${language}.`
            : `Write a voiceover for this ${spec.label} video.\n\n` +
              `Video concept: ${input.prompt}\n` +
              `Style: ${spec.blurb}\n` +
              (brand ? `${brand}\n` : "") +
              `\n${NARRATION_PERSPECTIVE[input.kind]}\n` +
              `\n${toneLine}\n` +
              `\nHard limit: about ${words} words — it must be speakable in ` +
              `${input.seconds.toFixed(1)} seconds at an unhurried pace. ` +
              `Open strong; end on a clear beat.` +
              `\nWrite it in ${language}.`,
        },
      ],
    }),
    signal: AbortSignal.timeout(SCRIPT_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`script generation failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = data.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error("script generation returned empty content");

  let parsed: { script?: unknown; cta?: unknown };
  try {
    parsed = JSON.parse(raw) as { script?: unknown; cta?: unknown };
  } catch {
    // The model answered with prose despite response_format. That is still a
    // usable script — losing the whole narration over a missing CTA would be
    // the wrong trade.
    return { script: clean(raw), cta: "" };
  }
  const script = clean(typeof parsed.script === "string" ? parsed.script : "");
  if (!script) throw new Error("script generation returned no script");
  return { script, cta: clean(typeof parsed.cta === "string" ? parsed.cta : "").slice(0, 60) };
}

/** Strip stray wrapping quotes the model sometimes adds despite instructions. */
function clean(text: string): string {
  return text.replace(/^["'`]+|["'`]+$/g, "").trim();
}

/**
 * Speak the script with OpenAI TTS. Returns MP3 bytes.
 *
 * `tone` steers the delivery only — the words already reflect it (writeScript).
 */
export async function synthesize(
  script: string,
  tone?: ContentTone | null,
  kind: VideoKind = "ugc",
): Promise<Buffer> {
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: VOICEOVER_VOICE,
      input: script,
      instructions: deliveryFor(tone, kind),
      response_format: "mp3",
    }),
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`tts failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Write a narration that actually fits, by shortening the WORDS rather than
 * speeding up the read.
 *
 * Each round measures the real spoken length — TTS pace varies with the tone
 * instruction and the language, so a word count is an estimate and only the
 * rendered audio is a fact. An overshoot is fed back as a concrete new budget,
 * scaled by how far over it landed.
 */
export async function narrationWithinBudget(input: {
  prompt: string;
  kind: VideoKind;
  seconds: number;
  profile?: BrandProfile | null;
  tone?: ContentTone | null;
  speechPath: string;
  /**
   * The script the storyboard was built from, when there is one.
   *
   * Using it is the whole point of planning. Without this, post-production
   * wrote its OWN script from the prompt and spoke that instead — so a clip
   * planned around "I slept while ZidaneAI handled my marketing" was shot for
   * those lines and then narrated with "It's late, I'm alone, but ZidaneAI
   * handles my entire launch". Two competent scripts about the same idea, and
   * the pictures matched neither the words nor the beats they were cut for.
   *
   * It still goes through the budget loop below: a planned script is not
   * exempt from having to fit, and the rewrite path shortens it exactly as it
   * would shorten a freshly written one.
   */
  plannedScript?: string | null;
  plannedCta?: string | null;
  /** Canonical spellings applied to the script before it is ever spoken. */
  canonical?: string[];
}): Promise<{ draft: ScriptDraft; spoken: Buffer; spokenSec: number }> {
  const planned = (input.plannedScript ?? "").trim();
  let draft: ScriptDraft = planned
    ? { script: planned, cta: (input.plannedCta ?? "").trim() }
    : await writeScript({
        prompt: input.prompt,
        kind: input.kind,
        seconds: input.seconds,
        profile: input.profile,
        tone: input.tone,
      });
  // Repair the identity words BEFORE synthesis, so the voice pronounces the
  // brand from its correct spelling and the captions inherit it. A script
  // model that typed the company name slightly wrong would otherwise have that
  // spelling read aloud and burned into the picture.
  const fix = (d: ScriptDraft): ScriptDraft => ({
    script: repairTerms(d.script, input.canonical ?? []),
    cta: repairTerms(d.cta, input.canonical ?? []),
  });
  draft = fix(draft);
  let spoken = await synthesize(draft.script, input.tone, input.kind);
  await fs.writeFile(input.speechPath, spoken);
  let spokenSec = await probeDuration(input.speechPath);

  const budget = input.seconds * MAX_TEMPO;
  for (let attempt = 0; attempt < SCRIPT_REWRITES && spokenSec > budget; attempt++) {
    const wordCount = draft.script.trim().split(/\s+/).length;
    // Aim slightly under the budget: landing exactly on it leaves no room for
    // the natural variation between one TTS render and the next.
    const targetWords = Math.max(6, Math.floor((wordCount * input.seconds * 0.94) / spokenSec));
    console.log(
      `[video/postproduce] narration ${spokenSec.toFixed(1)}s over ${input.seconds.toFixed(1)}s ` +
        `budget — rewriting ${wordCount} words to ~${targetWords}`,
    );
    const shorter = await writeScript({
      prompt: input.prompt,
      kind: input.kind,
      seconds: input.seconds,
      profile: input.profile,
      tone: input.tone,
      shorten: { previous: draft.script, targetWords },
    });
    const reSpoken = await synthesize(shorter.script, input.tone, input.kind);
    await fs.writeFile(input.speechPath, reSpoken);
    const reSec = await probeDuration(input.speechPath);
    // Keep the rewrite only if it actually helped — a model that returns
    // something longer must not make the clip worse than the draft we had.
    if (reSec < spokenSec) {
      // The CTA is written alongside the script, so carry the better draft's
      // CTA only when its script is the one we keep.
      draft = fix({ script: shorter.script, cta: shorter.cta || draft.cta });
      spoken = reSpoken;
      spokenSec = reSec;
    } else {
      await fs.writeFile(input.speechPath, spoken);
      break;
    }
  }

  return { draft, spoken, spokenSec };
}
