import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * Measuring media files, and checking we can.
 *
 * Split out of postproduce.ts because validation also needs to measure things,
 * and postproduce needs validation — importing each other directly makes a
 * cycle. These functions depend on nothing else in the app, so they are the
 * natural thing to pull out: everything here is a question ffprobe answers.
 */

const exec = promisify(execFile);

const PROBE_TIMEOUT_MS = 15_000;

/**
 * ffmpeg and ffprobe are external binaries, not npm dependencies — nothing in
 * package.json installs them and nothing else in the app needs them. On a host
 * without them every narration attempt fails identically, so probe once and
 * report a cause the operator can act on instead of an opaque ENOENT per clip.
 *
 * Cached for the life of the process: the answer cannot change without a
 * redeploy or a package install, and this runs on the video status hot path.
 */
let toolCheck: Promise<string | null> | null = null;
export function missingMediaTools(): Promise<string | null> {
  toolCheck ??= (async () => {
    for (const bin of ["ffmpeg", "ffprobe"]) {
      try {
        await exec(bin, ["-version"], { timeout: 10_000 });
      } catch {
        return `${bin} not found on PATH — install ffmpeg to enable narration`;
      }
    }
    return null;
  })();
  return toolCheck;
}

/** Read a media file's duration in seconds via ffprobe. */
export async function probeDuration(file: string): Promise<number> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    file,
  ], { timeout: PROBE_TIMEOUT_MS });
  const n = Number(stdout.trim());
  if (!Number.isFinite(n)) throw new Error(`ffprobe returned no duration for ${file}`);
  return n;
}

/** Pixel dimensions of a video's first video stream. */
export async function probeDimensions(file: string): Promise<{ width: number; height: number }> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    file,
  ], { timeout: PROBE_TIMEOUT_MS });
  const [w, h] = stdout.trim().split(",").map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new Error(`ffprobe returned no dimensions for ${file}`);
  }
  return { width: w, height: h };
}

/** True when the file carries at least one audio stream. */
export async function hasAudio(file: string): Promise<boolean> {
  const { stdout } = await exec("ffprobe", [
    "-v", "error",
    "-select_streams", "a",
    "-show_entries", "stream=codec_type",
    "-of", "csv=p=0",
    file,
  ], { timeout: PROBE_TIMEOUT_MS });
  return stdout.trim().length > 0;
}
