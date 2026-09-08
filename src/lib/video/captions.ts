import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { launchBrowser } from "@/lib/video/capture";
import { createOfflineRenderContext } from "@/lib/video/capture-network";
import { repairTerms } from "@/lib/brand/canonical";
import { env, openaiConfigured } from "@/lib/env";
import { brandTypography, fontStack } from "@/lib/video/fonts";
import type { BrandKit } from "@/lib/brand";

const exec = promisify(execFile);

/**
 * Burned-in captions for short-form clips.
 *
 * ffmpeg's own text filters are not an option: `subtitles`, `drawtext` and
 * `ass` all depend on libass/freetype, and the build on at least one machine
 * here has none of them ("No such filter: 'drawtext'"). Since postproduce
 * resolves ffmpeg from PATH rather than pinning a build, captions that work on
 * one host and silently vanish on another are worse than no captions.
 *
 * So the text is typeset by the browser that is already part of this pipeline —
 * the same headless Chromium `makeOverlayLogo` uses — screenshotted with
 * `omitBackground` to a transparent PNG, and composited with `overlay`, which
 * is plain libavfilter and present everywhere. No new dependency, and the
 * typesetting is done by something that actually understands fonts.
 *
 * Timings come from a Whisper pass over the generated speech. TTS returns no
 * word timings, and captions that drift out of sync read worse than none.
 */

export interface CaptionCue {
  start: number;
  end: number;
  text: string;
}

interface Word {
  word: string;
  start: number;
  end: number;
}

/**
 * How the words are set.
 *
 * Captions used to be short-form only, on the reasoning that "a cinematic brand
 * film with subtitles stapled across it is not the same product". That is true
 * of ONE treatment, not of captions: the majority of social video is watched
 * muted, so a clip whose words only exist in the audio is a clip most viewers
 * never hear. The answer is a second treatment rather than no captions.
 *
 *  - `impact`  Big, uppercase, heavy outline, sitting high off the bottom.
 *              The TikTok/Reels convention. For UGC and short-form.
 *  - `subtle`  Sentence case, lighter weight, smaller, tucked into the
 *              lower-third like broadcast subtitles. For cinematic and demo,
 *              where the picture is the point and the words support it.
 */
export type CaptionStyle = "impact" | "subtle";

interface StyleSpec {
  /** Caption band as a share of video height, and its distance off the bottom. */
  bandHeightRatio: number;
  bandBottomRatio: number;
  /** Font size as a share of the band height. */
  fontRatio: number;
  weight: number;
  uppercase: boolean;
  /** Outline width as a share of font size. */
  strokeRatio: number;
  /** Words per cue — impact captions pulse, subtle ones read as sentences. */
  maxWords: number;
}

const STYLES: Record<CaptionStyle, StyleSpec> = {
  impact: {
    bandHeightRatio: 0.22,
    bandBottomRatio: 0.16,
    fontRatio: 0.3,
    weight: 800,
    uppercase: true,
    strokeRatio: 0.06,
    maxWords: 4,
  },
  subtle: {
    bandHeightRatio: 0.14,
    bandBottomRatio: 0.07,
    fontRatio: 0.32,
    weight: 600,
    uppercase: false,
    strokeRatio: 0.035,
    maxWords: 7,
  },
};

/** Cue pacing — long enough not to strobe. */
const MAX_CUE_SECONDS = 2.2;
/** A runaway filter graph helps nobody; past this the clip ships uncaptioned. */
const MAX_CUES = 40;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 90_000;
const BURN_TIMEOUT_MS = 240_000;

/** Word-level timings for the spoken audio, or null if unavailable. */
async function wordTimings(mp3: Buffer): Promise<Word[] | null> {
  if (!openaiConfigured) return null;
  try {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(mp3)], { type: "audio/mpeg" }), "speech.mp3");
    // whisper-1 rather than the gpt-4o transcribe models: it is the one that
    // returns per-WORD timestamps, which is the whole reason for this call.
    form.append("model", "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "word");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.openaiKey}` },
      body: form,
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[video/captions] transcribe failed (${res.status})`);
      return null;
    }
    const data = (await res.json()) as { words?: Word[] };
    const words = (data.words ?? []).filter(
      (w) => typeof w.start === "number" && typeof w.end === "number" && !!w.word,
    );
    return words.length ? words : null;
  } catch (err) {
    console.error("[video/captions] transcribe error:", err);
    return null;
  }
}

/**
 * Put the WRITTEN words back, keeping the transcription's timings.
 *
 * Whisper is here for one thing — when each word is spoken — because TTS
 * returns no timings and captions that drift read worse than none. Its
 * TRANSCRIPT is a different matter: it is a guess at audio we generated from
 * text we still have, and it guesses worst on exactly the words that matter
 * most. The first real run captioned "ZidaneAI" as "ZDANE AI", burned into the
 * video, on the brand's own advert.
 *
 * So the timeline comes from the transcription and the spelling comes from the
 * script. When the token counts agree the mapping is one-to-one; when they do
 * not — a contraction split, a number read as several words — the script is
 * spread proportionally across the same span, which keeps the words right and
 * the drift within a cue.
 */
export function retextWords(words: Word[], scriptText: string): Word[] {
  const tokens = scriptText.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || words.length === 0) return words;

  if (tokens.length === words.length) {
    return words.map((w, i) => ({ ...w, word: tokens[i] }));
  }

  const start = words[0].start;
  const end = words[words.length - 1].end;
  const span = Math.max(0.001, end - start);
  return tokens.map((t, i) => ({
    word: t,
    start: start + (span * i) / tokens.length,
    end: start + (span * (i + 1)) / tokens.length,
  }));
}

/** Pack words into readable cues, breaking on length or a gap in speech. */
export function groupCues(words: Word[], maxWords = STYLES.impact.maxWords): CaptionCue[] {
  const cues: CaptionCue[] = [];
  let bucket: Word[] = [];
  const flush = () => {
    if (!bucket.length) return;
    cues.push({
      start: bucket[0].start,
      end: bucket[bucket.length - 1].end,
      text: bucket.map((w) => w.word).join(" ").replace(/\s+/g, " ").trim(),
    });
    bucket = [];
  };
  for (const w of words) {
    if (bucket.length) {
      const tooLong = bucket.length >= maxWords;
      const tooSlow = w.end - bucket[0].start > MAX_CUE_SECONDS;
      if (tooLong || tooSlow) flush();
    }
    bucket.push(w);
  }
  flush();
  return cues.slice(0, MAX_CUES);
}

/**
 * Typeset each cue as a transparent PNG the full width of the video.
 *
 * Every cue is rendered into an identically sized band so the composite step
 * can use one constant y offset instead of measuring each image.
 */
async function renderCues(
  cues: CaptionCue[],
  width: number,
  bandHeight: number,
  kit: BrandKit | null | undefined,
  dir: string,
  spec: StyleSpec,
): Promise<{ paths: string[]; fontFallback: boolean } | null> {
  const browser = await launchBrowser().catch(() => null);
  if (!browser) {
    console.error("[video/captions] no browser to typeset with");
    return null;
  }
  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    context = await createOfflineRenderContext(browser, {
      viewport: { width, height: bandHeight },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const paths: string[] = [];
    // The brand's real typeface, fetched and embedded rather than merely named.
    // A named family is almost never installed on a render host, so naming one
    // is indistinguishable from not having it — see lib/video/fonts.
    const type = await brandTypography(kit);
    const stack = fontStack(type.headingFamily ?? type.bodyFamily, !type.fallback);
    const fontSize = Math.round(bandHeight * spec.fontRatio);
    const stroke = Math.max(2, Math.round(fontSize * spec.strokeRatio));

    for (const [i, cue] of cues.entries()) {
      const safe = cue.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      await page.setContent(
        `<!doctype html><meta charset="utf-8"><style>` +
          type.css +
          `html,body{margin:0;padding:0;background:transparent;height:${bandHeight}px}` +
          `#c{display:flex;align-items:center;justify-content:center;` +
          `height:${bandHeight}px;padding:0 6%;box-sizing:border-box;` +
          `font-family:${stack};font-weight:${spec.weight};font-size:${fontSize}px;line-height:1.15;` +
          `text-align:center;color:#fff;letter-spacing:.01em;` +
          `text-transform:${spec.uppercase ? "uppercase" : "none"};` +
          // A heavy outline plus a drop shadow is what keeps white lettering
          // readable over both a bright window and a dark jacket.
          `-webkit-text-stroke:${stroke}px #000;` +
          `paint-order:stroke fill;` +
          `text-shadow:0 ${Math.round(fontSize * 0.06)}px ${Math.round(fontSize * 0.12)}px rgba(0,0,0,.65)}` +
          `</style><div id="c">${safe}</div>`,
      );
      const shot = await page.locator("#c").screenshot({ type: "png", omitBackground: true });
      const file = path.join(dir, `cue-${i}.png`);
      await fs.writeFile(file, shot);
      paths.push(file);
    }
    return { paths, fontFallback: type.fallback };
  } catch (err) {
    console.error("[video/captions] typesetting failed:", err);
    return null;
  } finally {
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/** Composite the cue images onto the clip, each shown only for its own window. */
async function burn(
  videoPath: string,
  cues: CaptionCue[],
  pngs: string[],
  y: number,
  outPath: string,
): Promise<void> {
  const args: string[] = ["-y", "-i", videoPath];
  for (const p of pngs) args.push("-i", p);

  // Chain one overlay per cue, each gated to its own time window. `enable`
  // takes an expression full of commas, so it is single-quoted: ffmpeg parses
  // those itself, and execFile passes the argument through without a shell.
  const steps = cues.map((cue, i) => {
    const from = i === 0 ? "[0:v]" : `[v${i}]`;
    const to = `[v${i + 1}]`;
    return `${from}[${i + 1}:v]overlay=0:${y}:enable='between(t,${cue.start.toFixed(3)},${cue.end.toFixed(3)})'${to}`;
  });

  args.push(
    "-filter_complex",
    steps.join(";"),
    "-map",
    `[v${cues.length}]`,
    "-map",
    "0:a?",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    outPath,
  );
  await exec("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16, timeout: BURN_TIMEOUT_MS });
}

/**
 * Caption `videoPath` into `outPath`. Returns false when the clip should ship
 * as-is — no speech, no browser, no transcription. Never throws: an uncaptioned
 * clip is a fine outcome, a failed render is not.
 */
export async function addCaptions(input: {
  videoPath: string;
  speech: Buffer;
  outPath: string;
  width: number;
  height: number;
  /** The workspace kit, for its palette-matched typeface. */
  brandKit?: BrandKit | null;
  /** Treatment for this video type. Defaults to the TikTok-style one. */
  style?: CaptionStyle;
  /**
   * The exact words that were spoken. Whisper supplies the timings; this
   * supplies the spelling. See `retextWords`.
   */
  scriptText?: string;
  /**
   * Stop drawing cues at this timestamp. The end card carries its own CTA and
   * URL, typeset for that frame — running captions over it stacks two pieces of
   * text on one another and lands the narration's last words on top of the
   * call to action.
   */
  stopAt?: number;
  /**
   * Spellings that outrank the transcription — the customer's own name, product
   * and domain. Whisper guesses at audio we synthesised from text we still
   * have, and it guesses worst on exactly these words.
   */
  canonicalTerms?: string[];
}): Promise<{ ok: boolean; fontFallback: boolean }> {
  const { videoPath, speech, outPath, width, height } = input;
  const spec = STYLES[input.style ?? "impact"];
  let dir: string | null = null;
  try {
    const heard = await wordTimings(speech);
    if (!heard) return { ok: false, fontFallback: true };
    const scriptText = input.scriptText
      ? repairTerms(input.scriptText, input.canonicalTerms ?? [])
      : undefined;
    const words = scriptText
      ? retextWords(heard, scriptText)
      // No script to fall back on: repair the transcription itself, so a
      // mangled brand name is corrected even on this path.
      : heard.map((w) => ({ ...w, word: repairTerms(w.word, input.canonicalTerms ?? []) || w.word }));
    let cues = groupCues(words, spec.maxWords);
    if (typeof input.stopAt === "number") {
      const limit = input.stopAt;
      cues = cues
        .filter((c) => c.start < limit)
        // A cue that straddles the boundary is clipped rather than dropped:
        // losing the last three words mid-sentence reads as a bug.
        .map((c) => (c.end > limit ? { ...c, end: limit } : c));
    }
    if (!cues.length) return { ok: false, fontFallback: true };

    const bandHeight = Math.max(64, Math.round(height * spec.bandHeightRatio));
    const y = Math.max(0, height - bandHeight - Math.round(height * spec.bandBottomRatio));

    dir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-caps-"));
    const rendered = await Promise.race([
      renderCues(cues, width, bandHeight, input.brandKit, dir, spec),
      new Promise<null>((r) => setTimeout(() => r(null), RENDER_TIMEOUT_MS)),
    ]);
    if (!rendered?.paths.length) return { ok: false, fontFallback: true };

    await burn(videoPath, cues, rendered.paths, y, outPath);
    return { ok: true, fontFallback: rendered.fontFallback };
  } catch (err) {
    console.error("[video/captions] failed:", err);
    return { ok: false, fontFallback: true };
  } finally {
    if (dir) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
