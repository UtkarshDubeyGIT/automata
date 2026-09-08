import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import { createAdminClient } from "@/lib/supabase/server";
import { probeDuration } from "@/lib/video/probe";
import {
  TAKE_HEAD_TRIM_SECONDS,
  presetForRatio,
  type AspectRatio,
} from "@/lib/video/higgsfield";

/**
 * Assembly of a long clip out of the fixed ~5.4s takes the video model returns.
 *
 * Takes are mirrored into our own Storage bucket as they finish: a 30s clip is
 * six renders that land minutes apart, and the whole set has to still be
 * fetchable when the last one arrives — longer than the provider CDN is meant
 * to be relied on.
 */

const exec = promisify(execFile);

const FETCH_TIMEOUT_MS = 120_000;
const FFMPEG_TIMEOUT_MS = 300_000;

export interface Take {
  /** Position in the cut. */
  index: number;
  /**
   * Provider request id — the identity we poll and de-duplicate on.
   *
   * Shots that are not provider renders still carry one, in the form
   * `local:<kind>:<index>`. They are never polled (see `isLocalTake`), but
   * giving them an id keeps `parseTakes` and every take-counting call site
   * working unchanged on a mixed list.
   */
  requestId: string;
  /** Our storage URL, once the take has rendered and been stored. */
  url?: string;
  /** Measured length in seconds, once stored. */
  seconds?: number;
  /** Set when the provider gave up on this take; it is dropped from the cut. */
  failed?: boolean;

  // ---- v2 pipeline. Absent on every row the old path wrote. ----

  /** What kind of shot this is — see ShotKind in plan.ts. */
  kind?: string;
  /** The frame this take animates from. */
  keyframeUrl?: string;
  /** What the shot is meant to show, carried for re-rendering and validation. */
  visual?: string;
  /** How the shot moves. */
  direction?: string;
  /** How many times this shot has been submitted. Bounds re-rendering. */
  attempts?: number;
  /** What the post-render check found, if it ran. */
  validation?: { ok: boolean; problems: string[] };
}

/** A shot produced locally — a screen recording — rather than by the provider. */
export function isLocalTake(take: Take): boolean {
  return take.requestId.startsWith("local:");
}

/** Parse the `segments` jsonb column defensively — it is data, not a contract. */
export function parseTakes(value: unknown): Take[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (t): t is Take =>
        !!t &&
        typeof t === "object" &&
        typeof (t as Take).index === "number" &&
        typeof (t as Take).requestId === "string",
    )
    .sort((a, b) => a.index - b.index);
}

/** Takes that are rendered and usable, in cut order. */
export function renderedTakes(takes: Take[]): Take[] {
  return takes.filter((t) => !!t.url && !t.failed);
}

/** Takes still waiting on the provider. */
export function pendingTakes(takes: Take[]): Take[] {
  return takes.filter((t) => !t.url && !t.failed);
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  await fs.writeFile(to, Buffer.from(await res.arrayBuffer()));
}

async function upload(
  storagePath: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  const db = createAdminClient();
  const { error } = await db.storage
    .from("videos")
    .upload(storagePath, body, { contentType, upsert: true });
  if (error) throw new Error(`upload ${storagePath} failed: ${error.message}`);
  return db.storage.from("videos").getPublicUrl(storagePath).data.publicUrl;
}

/** Pull a finished take off the provider CDN, measure it, and store it. */
export async function storeTake(input: {
  sourceUrl: string;
  workspaceId: string;
  jobId: string;
  index: number;
  /**
   * Called with the take on local disk, before it is cleaned up.
   *
   * This exists so the rendered-shot check can read frames out of a file we
   * have already downloaded. Validating after the fact would mean fetching the
   * same clip a second time, per take, on every generation — the bytes are
   * right here and only briefly.
   *
   * Must not throw: inspection is advisory and a take that could not be looked
   * at is still a take.
   */
  inspect?: (localPath: string) => Promise<void>;
}): Promise<{ url: string; seconds: number }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-take-"));
  try {
    const clip = path.join(tmpDir, "take.mp4");
    await download(input.sourceUrl, clip);
    const seconds = await probeDuration(clip);
    if (input.inspect) {
      await input.inspect(clip).catch((err) => {
        console.error(`[video/stitch] take ${input.index} inspection failed:`, err);
      });
    }
    const url = await upload(
      `${input.workspaceId}/${input.jobId}/take-${input.index}.mp4`,
      await fs.readFile(clip),
      "video/mp4",
    );
    return { url, seconds };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The filter that makes the chosen FORMAT true of the delivered file.
 *
 * Aspect ratio was only ever a request, never a guarantee. It was passed to
 * the keyframe model and to nothing else — so a clip built from a supplied
 * asset came out in the asset's shape, and even a generated keyframe was only
 * as close to the target as the image model felt like being. Meanwhile the UI
 * printed exact pixel dimensions and history laid the player out with the
 * ratio the user asked for, so a square clip was stretched into a 16:9 box.
 *
 * Scale-then-crop rather than pad: these are social videos, and a letterboxed
 * Reel with black bars down two sides reads as a mistake. `increase` scales
 * until the frame is covered on both axes, and the crop takes the centre.
 * `setsar=1` stops a non-square pixel aspect from re-stretching it downstream.
 */
function conformFilter(ratio: AspectRatio): string {
  const { width, height } = presetForRatio(ratio);
  return (
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},setsar=1`
  );
}

/**
 * Cut the takes together into one clip, in the requested format, and store it.
 *
 * Every take after the first is trimmed at the head (TAKE_HEAD_TRIM_SECONDS):
 * they all begin on the same keyframe, so an untrimmed join snaps the subject
 * back to its opening pose at every cut. That trim is why this is a filter
 * graph and a re-encode rather than the concat demuxer's stream copy — one
 * pass over ~30s of 720p, which is seconds of CPU, not minutes.
 *
 * The planned pipeline weakens that premise without removing it: its shots
 * animate from DIFFERENT keyframes, so there is no shared opening pose to cut
 * away from. The trim stays anyway, for two reasons. Any shot whose derivation
 * failed falls back to the master frame (see keyframes.ts), so identical
 * openings still occur and are invisible until they are on screen. And the
 * advertised clip lengths are computed from this constant — `assembledSeconds`
 * feeds TAKE_LENGTHS, the picker and the price — so dropping it silently
 * re-labels every length the product sells. Half a second per cut is the
 * cheaper of the two mistakes.
 *
 * The conform runs per input, BEFORE the concat, for two reasons. It is what
 * makes the format real (see conformFilter), and ffmpeg's concat filter
 * requires every input to share dimensions — takes that came back at different
 * sizes failed the whole join, which surfaced as a clip stuck in assembly
 * rather than as anything anyone could read.
 *
 * A single take goes through the same encode instead of a file copy. It costs
 * one short pass and means a 5s clip and a 39s clip are the same shape, which
 * a copy could never promise.
 */
export async function concatTakes(input: {
  takes: Take[];
  workspaceId: string;
  jobId: string;
  /** Format to deliver in. Defaults to vertical, as presetForRatio does. */
  aspectRatio?: AspectRatio;
}): Promise<{ url: string; durationSec: number }> {
  const usable = renderedTakes(input.takes);
  if (usable.length === 0) throw new Error("no rendered takes to join");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-stitch-"));
  try {
    const files: string[] = [];
    for (const [i, take] of usable.entries()) {
      const file = path.join(tmpDir, `take-${i}.mp4`);
      await download(take.url!, file);
      files.push(file);
    }

    const out = path.join(tmpDir, "full.mp4");
    const conform = conformFilter(input.aspectRatio ?? "9:16");

    const args: string[] = ["-y"];
    files.forEach((file, i) => {
      // Seek before -i so the trim is applied while decoding, not after.
      if (i > 0) args.push("-ss", String(TAKE_HEAD_TRIM_SECONDS));
      args.push("-i", file);
    });
    const graph =
      files.map((_, i) => `[${i}:v:0]${conform}[c${i}];`).join("") +
      files.map((_, i) => `[c${i}]`).join("") +
      `concat=n=${files.length}:v=1:a=0[v]`;
    args.push(
      "-filter_complex", graph,
      "-map", "[v]",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      out,
    );
    await exec("ffmpeg", args, {
      timeout: FFMPEG_TIMEOUT_MS,
      maxBuffer: 1024 * 1024 * 16,
    });

    const durationSec = await probeDuration(out);
    const url = await upload(
      `${input.workspaceId}/${input.jobId}-full.mp4`,
      await fs.readFile(out),
      "video/mp4",
    );
    return { url, durationSec };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
