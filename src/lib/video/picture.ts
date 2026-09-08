import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrandProfile } from "@/lib/brand";
import { probeDimensions, probeDuration } from "@/lib/video/probe";
import { MAX_TEMPO } from "@/lib/video/narration";
import { fetchPublicUrl } from "@/lib/net/public-fetch";

/**
 * The picture half of post-production: cutting the footage to length, laying
 * the narration onto it, and compositing the brand mark.
 *
 * Every ffmpeg invocation in the voiceover pipeline lives here, which is the
 * point of the split — these are the steps that fail for environmental reasons
 * (a codec, a filter graph, a missing binary) rather than for reasons a model
 * chose, and having them in one file means a rendering failure has one place to
 * look. `narration.ts` is the other half; `postproduce.ts` is the orchestrator
 * that runs them in order and decides what a failure costs.
 *
 * Two rules hold across all of them:
 *
 * - **The picture is never shortened to fit the audio.** `buildPicture` decides
 *   the delivered length once, and `mux` copies the video track untouched — a
 *   read that runs long is absorbed by tempo (bounded by `MAX_TEMPO`), never by
 *   dropping frames the user paid for.
 * - **Branding is best-effort, the render is not.** `fetchLogo` answers null for
 *   anything it cannot use, and the caller keeps the unbranded cut. An
 *   unbranded clip is a fine outcome; a failed render is not.
 */

const exec = promisify(execFile);

/** How long a logo or music bed may take to fetch before the clip goes out
 *  without it. */
const LOGO_FETCH_TIMEOUT_MS = 20_000;

/** Ceiling on any single ffmpeg pass. */
const MUX_TIMEOUT_MS = 180_000;

/** Composited logo width, as a share of the frame width. */
const LOGO_WIDTH_RATIO = 0.14;
/** Corner inset, as a share of the frame's shorter side. */
const LOGO_MARGIN_RATIO = 0.04;

/**
 * Burn the brand's real logo into the lower-right corner.
 *
 * The generative model is told not to draw branding at all (see
 * `brandVideoHint`), because what it produces is always an approximation of a
 * logo rather than the logo. The genuine asset is composited here instead, so
 * what ships is pixel-exact.
 *
 * The logo is pre-scaled to a width derived from the probed frame rather than
 * with in-filter arithmetic, so the maths is visible and the same on every
 * aspect ratio.
 */
export async function overlayLogo(
  videoPath: string,
  logoPath: string,
  outPath: string,
  /**
   * Stop showing the corner mark at this timestamp — the end card carries the
   * logo at full size and centred, so leaving the corner copy running stacks
   * the same mark twice in one frame.
   */
  stopAt?: number,
): Promise<void> {
  const { width, height } = await probeDimensions(videoPath);
  const logoWidth = Math.max(48, Math.round(width * LOGO_WIDTH_RATIO));
  const margin = Math.round(Math.min(width, height) * LOGO_MARGIN_RATIO);
  const gate = typeof stopAt === "number" ? `:enable='lt(t,${stopAt.toFixed(3)})'` : "";

  await exec("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-i", logoPath,
    "-filter_complex",
    // -1 keeps the logo's own aspect ratio; force_original_aspect_ratio is not
    // needed for a single-axis scale. The alpha channel is preserved so a
    // transparent PNG/SVG-derived mark does not gain a white box.
    `[1:v]format=rgba,scale=${logoWidth}:-1[lg];` +
      `[0:v][lg]overlay=main_w-overlay_w-${margin}:main_h-overlay_h-${margin}:format=auto${gate}`,
    // The audio track is already correct from the mux; copy it untouched.
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ], { maxBuffer: 1024 * 1024 * 16, timeout: MUX_TIMEOUT_MS });
}

/**
 * Fetch the brand logo to disk. Returns null when there is no logo, it is
 * unreachable, or it is too small to be real — a missing logo must degrade to
 * an unbranded clip, never fail the render.
 *
 * Reads `logoOverlayUrl`, NOT `logoUrl`, and never falls back to it. The
 * display logo is whatever best pictures the brand: often an SVG, which ffmpeg
 * cannot decode, and often opaque — an apple-touch-icon, a cropped screenshot,
 * a share card — which composites as a solid rectangle in the corner. The
 * overlay URL is the one asset proven transparent and rasterized for this
 * purpose (see makeOverlayLogo). Its absence means we could not make one, and
 * an unbranded clip is the intended answer to that.
 */
export async function fetchLogo(profile: BrandProfile | null | undefined, dir: string): Promise<string | null> {
  const url = profile?.brandKit?.logoOverlayUrl;
  if (!url || !/^https?:/.test(url)) return null;
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null; // too small to be a real logo
    // ffmpeg sniffs the container, so the extension is only a hint.
    const file = path.join(dir, "logo.img");
    await fs.writeFile(file, buf);
    return file;
  } catch {
    return null;
  }
}

/**
 * Fetch an optional music bed to disk. Returns null for "no music", which is
 * every clip today — v1 ships without a track because none is licensed, and
 * silently substituting one would put an unlicensed recording on a user's ad.
 */
export async function fetchMusic(
  url: string | null | undefined,
  dir: string,
): Promise<string | null> {
  if (!url || !/^https?:/.test(url)) return null;
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1024) return null;
    const file = path.join(dir, "music.audio");
    await fs.writeFile(file, buf);
    return file;
  } catch {
    return null;
  }
}

/**
 * Mux narration onto a silent clip.
 *
 * The video track is copied untouched, so the output is always exactly as long
 * as the picture — the clip is never shortened to fit the audio, which would
 * drop frames the user paid for. To keep the read intact inside that window:
 * a narration that runs long is gently sped up (bounded by MAX_TEMPO), and one
 * that comes in short is padded with silence.
 */
export async function mux(
  videoPath: string,
  audioPath: string,
  outPath: string,
  opts?: {
    /**
     * Optional licensed music bed, mixed under the narration and ducked
     * against it. Absent for v1 — no track ships with the product and we will
     * not license one on the user's behalf — but the wiring is here so adding
     * one later is a caller change, not a pipeline change.
     */
    musicPath?: string | null;
  },
): Promise<void> {
  const [videoSec, audioSec] = await Promise.all([
    probeDuration(videoPath),
    probeDuration(audioPath),
  ]);

  // atempo only accepts 0.5-2.0 per instance; our cap is well inside that.
  // By the time we get here the script has already been rewritten to fit, so
  // this is absorbing a fraction of a second, not compressing a long read.
  const tempo = audioSec > videoSec ? Math.min(audioSec / videoSec, MAX_TEMPO) : 1;
  const voice = tempo > 1 ? `[1:a]atempo=${tempo.toFixed(4)},apad[vo]` : "[1:a]apad[vo]";

  const args = ["-y", "-i", videoPath, "-i", audioPath];
  let filter: string;
  if (opts?.musicPath) {
    args.push("-stream_loop", "-1", "-i", opts.musicPath);
    // sidechaincompress ducks the music whenever the narration is speaking:
    // the voice drives the gain reduction, so the bed drops under words and
    // comes back up in the gaps without anyone drawing an automation curve.
    filter =
      `${voice};[vo]asplit=2[vo1][vo2];` +
      `[2:a]volume=0.18,aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[bed];` +
      `[bed][vo1]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[ducked];` +
      `[vo2][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]`;
  } else {
    filter = `${voice};[vo]anull[a]`;
  }

  args.push(
    "-filter_complex", filter,
    "-map", "0:v:0",
    "-map", "[a]",
    "-c:v", "copy",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    "-movflags", "+faststart",
    outPath,
  );
  await exec("ffmpeg", args, { maxBuffer: 1024 * 1024 * 16, timeout: MUX_TIMEOUT_MS });
}

/**
 * Cut the delivered picture: the footage, trimmed to make room, then the end
 * card — and the whole thing exactly `targetSec` long.
 *
 * The card is taken OUT of the clip's length rather than added to it. A user
 * who asked for 30 seconds and was billed for 30 seconds should receive 30
 * seconds; appending 1.8s of card would make every clip overrun its label, in
 * the same way the head trim used to make every clip undershoot it.
 *
 * Returns the card's start time so later stages know where the footage ends —
 * captions stop there, and the corner logo is suppressed over a card that
 * already carries the logo at full size.
 */
export async function buildPicture(input: {
  videoPath: string;
  outPath: string;
  targetSec: number;
  endCardPath: string | null;
  cardSec: number;
  width: number;
  height: number;
}): Promise<{ bodySec: number }> {
  const { videoPath, outPath, targetSec, endCardPath, cardSec, width, height } = input;
  const bodySec = Math.max(0.5, targetSec - (endCardPath ? cardSec : 0));

  if (!endCardPath) {
    // Nothing to append — just make the length exact.
    //
    // Re-encoded rather than stream-copied, which is the whole point: `-t` with
    // `-c copy` can only cut on a keyframe, so asking for 13.200s off a clip
    // with a 2s GOP hands back 13.292s. Measured, not assumed — that is exactly
    // what the first version of this branch did. A trim that is "exact to the
    // nearest keyframe" is not a trim to an exact duration.
    await exec("ffmpeg", [
      "-y",
      "-i", videoPath,
      "-filter_complex",
      `[0:v]trim=0:${bodySec.toFixed(3)},setpts=PTS-STARTPTS,fps=30,` +
        `scale=${width}:${height},setsar=1[v]`,
      "-map", "[v]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ], { maxBuffer: 1024 * 1024 * 16, timeout: MUX_TIMEOUT_MS });
    return { bodySec };
  }

  // A fixed frame rate on both inputs: the takes come back at whatever DoP
  // rendered and the card is a still, and concat splices timebases rather than
  // reconciling them — mismatched rates surface as a card that plays for a
  // fraction of its stated length.
  await exec("ffmpeg", [
    "-y",
    "-i", videoPath,
    "-loop", "1", "-t", cardSec.toFixed(3), "-i", endCardPath,
    "-filter_complex",
    `[0:v]trim=0:${bodySec.toFixed(3)},setpts=PTS-STARTPTS,fps=30,` +
      `scale=${width}:${height},setsar=1[body];` +
      `[1:v]fps=30,scale=${width}:${height},setsar=1,format=yuv420p[card];` +
      `[body][card]concat=n=2:v=1:a=0[v]`,
    "-map", "[v]",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    outPath,
  ], { maxBuffer: 1024 * 1024 * 16, timeout: MUX_TIMEOUT_MS });

  return { bodySec };
}
