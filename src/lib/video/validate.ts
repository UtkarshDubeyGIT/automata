import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import OpenAI from "openai";
import { env, openaiConfigured } from "@/lib/env";
import { probeDuration, probeDimensions, hasAudio } from "@/lib/video/probe";
import type { Shot } from "@/lib/video/plan";

const exec = promisify(execFile);

let _client: OpenAI | null = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: env.openaiKey });
  return _client;
}

/**
 * Looking at the work before shipping it — and, more importantly, before paying
 * for it.
 *
 * There are two moments worth checking, and they are worth very different
 * amounts. A bad KEYFRAME costs nothing to discard and everything to keep: it
 * is the single image all ~5.4 seconds of a take are animated from, so a
 * six-fingered hand in the frame is a six-fingered hand in every frame of the
 * shot, and the take that renders it costs 9 provider credits and up to nine
 * minutes. Checking the still first is the highest-leverage check in the whole
 * pipeline.
 *
 * A bad rendered SHOT is more expensive to find and more expensive to fix, but
 * only the failed shot is re-rendered — takes are independent provider
 * requests, so one bad shot out of six costs one re-render, not a new clip.
 *
 * Everything here is advisory and never throws. A validator that cannot run —
 * no key, a timeout, a model that answers with prose — must let the clip
 * through, because refusing to ship work we merely could not inspect is worse
 * than shipping it unchecked.
 */

const VISION_MODEL = "gpt-4o";
const VISION_TIMEOUT_MS = 60_000;
const MAX_TOKENS = 500;

export interface Verdict {
  ok: boolean;
  /** What is wrong, in the words the next attempt should act on. */
  problems: string[];
  /** Whether the check actually ran. False means "unknown", not "fine". */
  checked: boolean;
}

const UNCHECKED: Verdict = { ok: true, problems: [], checked: false };

interface VisionAnswer {
  ok?: boolean;
  problems?: unknown;
}

/**
 * Hand the model the BYTES, not a link to them.
 *
 * `image_url` makes OpenAI fetch the URL itself, and it gives up quickly:
 * a keyframe uploaded to our bucket moments earlier came back as
 * `invalid_image_url` — "Unable to download content from the provided URL
 * before the timeout" — on the very first run of this validator. The call
 * fails, the verdict degrades to `unchecked`, and the frame sails through
 * unvalidated. That is the worst possible failure for a gate whose entire job
 * is to run BEFORE money is spent: it is silent, and it looks like a pass.
 *
 * We can already reach our own storage, so fetching here and inlining removes
 * the dependency on OpenAI being able to reach it too. A URL we cannot fetch
 * is passed through as a URL, so a data: URI we built ourselves still works.
 */
async function inlineImage(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return url;
    const type = res.headers.get("content-type") ?? "image/png";
    if (!type.startsWith("image/")) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    // Well inside the 20MB request ceiling; a keyframe is a fraction of this.
    if (buf.length < 200 || buf.length > 15_000_000) return url;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return url;
  }
}

/**
 * One vision call returning a strict pass/fail with reasons.
 *
 * `detail` is a real correctness knob, not a cost dial. "low" downsamples to
 * roughly 512px before the model sees anything, which is the right trade for
 * sampled video frames — those are checked for gross defects. It is the wrong
 * trade for a keyframe, where the questions are "how many fingers" and "is
 * there readable text on that cap": detail the downsample destroys, so the
 * model answers from a blur and returns a different subset of the real defects
 * on each call. Measured on one frame across two passes: "extra finger on their
 * left hand", then "legible branding on the cap", neither mentioning the other.
 * Both were real; the check simply could not see them at once.
 */
async function ask(
  system: string,
  userText: string,
  urls: string[],
  detail: "low" | "high" = "low",
): Promise<Verdict> {
  if (!openaiConfigured || urls.length === 0) return UNCHECKED;
  const images = await Promise.all(urls.map(inlineImage));
  try {
    const res = await client().chat.completions.create(
      {
        model: VISION_MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text" as const, text: userText },
              ...images.map((url) => ({
                type: "image_url" as const,
                image_url: { url, detail },
              })),
            ],
          },
        ],
      },
      { timeout: VISION_TIMEOUT_MS },
    );
    const raw = res.choices[0]?.message?.content?.trim();
    if (!raw) return UNCHECKED;
    const parsed = JSON.parse(raw) as VisionAnswer;
    const problems = Array.isArray(parsed.problems)
      ? parsed.problems.map((p) => String(p).trim()).filter(Boolean).slice(0, 6)
      : [];
    // `ok` is the model's verdict, but a model that lists problems and still
    // says ok has contradicted itself; trust the specifics over the summary.
    const ok = parsed.ok === true && problems.length === 0;
    return { ok, problems, checked: true };
  } catch (err) {
    console.error("[video/validate] vision call failed:", err);
    return UNCHECKED;
  }
}

/**
 * Check a keyframe before a take is ever submitted.
 *
 * The master frame is passed alongside so consistency can be judged rather than
 * asserted — "is this the same person in the same place" is a question about
 * two images, and the whole derivation strategy in keyframes.ts rests on the
 * answer being yes.
 */
export async function validateKeyframe(input: {
  frameUrl: string;
  masterUrl?: string | null;
  shot: Shot;
  expectProduct?: boolean;
}): Promise<Verdict> {
  const withMaster = !!input.masterUrl && input.masterUrl !== input.frameUrl;
  const images = withMaster ? [input.masterUrl as string, input.frameUrl] : [input.frameUrl];

  return ask(
    "You are a picky art director checking a single video keyframe before it is " +
      "animated. Every flaw you miss will be present in every frame of a five " +
      "second shot.\n" +
      'Return STRICT JSON: {"ok": true|false, "problems": ["..."]}.\n' +
      "Fail the frame for ANY of:\n" +
      "- Malformed human anatomy: wrong finger count, fused or missing fingers, " +
      "extra or missing limbs, warped faces, misaligned eyes, impossible joints.\n" +
      "- LEGIBLE branding drawn into the picture: a logo, wordmark, watermark, " +
      "sign, headline or UI label you can actually read. Branding is " +
      "composited later, so any of that is a defect.\n" +
      "  Do NOT fail incidental background texture that merely suggests text — " +
      "book spines, a distant screen, blurred signage. Those are set dressing " +
      "and every photograph of a room contains them; failing them rejects " +
      "usable frames and costs the shot its own keyframe.\n" +
      "- A product that looks melted, incoherent, or physically impossible.\n" +
      "- The frame not depicting the described shot at all.\n" +
      (withMaster
        ? "- The SECOND image not showing the same PERSON, wardrobe, location, " +
          "lighting and colour grade as the FIRST. A different face, a changed " +
          "outfit or a different room is a failure.\n" +
          "  Judge IDENTITY only. These are two different shots from one shoot, " +
          "so pose, framing, camera distance, expression, gesture and what the " +
          "hands are doing are all SUPPOSED to differ — that is what makes them " +
          "separate shots. Never fail the frame for those, and never fail it " +
          "for not matching the first image's composition.\n"
        : "") +
      (input.expectProduct
        ? "- The product not matching the reference it was supposed to reproduce.\n"
        : "") +
      "Be specific in `problems`: name what is wrong and where. Do not report " +
      "matters of taste, only defects.",
    (withMaster
      ? "First image: the reference frame. Second image: the frame to check.\n"
      : "") + `The shot is meant to show: ${input.shot.visual}`,
    images,
    // Full detail. This is the one check that runs BEFORE money is spent, on
    // an image every frame of a take inherits, and it is asked to count fingers
    // and read small text — so it is worth the tokens to let the model actually
    // see the frame. Keyframes are free at the provider; the take this gates
    // costs 9 credits and up to nine minutes.
    "high",
  );
}

/** Pull evenly spaced stills out of a clip as data URIs the vision model can read. */
async function sampleFrames(videoPath: string, count: number): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-frames-"));
  try {
    const seconds = await probeDuration(videoPath);
    const stamps = Array.from({ length: count }, (_, i) =>
      Math.max(0.1, (seconds * (i + 0.5)) / count),
    );
    const out: string[] = [];
    for (const [i, at] of stamps.entries()) {
      const file = path.join(dir, `f${i}.jpg`);
      try {
        await exec(
          "ffmpeg",
          ["-y", "-v", "error", "-ss", at.toFixed(2), "-i", videoPath, "-frames:v", "1",
            // Downscaled deliberately: the check is for gross defects, and a
            // full-resolution still is a much larger payload for no more signal.
            "-vf", "scale=512:-2", "-q:v", "5", file],
          { timeout: 30_000 },
        );
        const buf = await fs.readFile(file);
        out.push(`data:image/jpeg;base64,${buf.toString("base64")}`);
      } catch {
        // A frame we could not extract is one fewer sample, not a failure.
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Check a rendered shot by looking at stills from across it.
 *
 * Sampled rather than watched: three frames spread through five seconds catch
 * the failures that matter here — anatomy that breaks as the subject moves,
 * a product that morphs, text the model drew despite instructions — and cost a
 * fraction of what feeding whole video to a vision model would.
 */
export async function validateRenderedShot(input: {
  videoPath: string;
  shot: Shot;
}): Promise<Verdict> {
  const frames = await sampleFrames(input.videoPath, 3);
  if (frames.length === 0) return UNCHECKED;

  return ask(
    "You are checking frames sampled from a single rendered video shot.\n" +
      'Return STRICT JSON: {"ok": true|false, "problems": ["..."]}.\n' +
      "Fail for ANY of:\n" +
      "- Malformed human anatomy in any frame: wrong finger count, fused " +
      "fingers, extra limbs, warped or melting faces.\n" +
      "- A subject, product or background that changes identity between frames " +
      "— this is one continuous shot, so morphing is a defect.\n" +
      "- LEGIBLE branding drawn into the picture: a logo, wordmark, watermark " +
      "or sign you can actually read. Ignore incidental background texture " +
      "that merely suggests text.\n" +
      "- Frames that are blank, frozen, or almost entirely one colour.\n" +
      "Ignore motion blur, grain and shallow focus — those are cinematography, " +
      "not defects. Be specific in `problems`.",
    `These frames are in time order from one shot meant to show: ${input.shot.visual}`,
    frames,
  );
}

export interface FinalCheck extends Verdict {
  /** Measured facts, recorded whether or not they pass. */
  measured: {
    durationSec: number;
    width: number;
    height: number;
    audio: boolean;
  };
}

/**
 * The last gate: does the delivered file match what was promised?
 *
 * Purely technical and entirely local — no model, no cost, no judgement. These
 * are the claims the product makes on the user's behalf (this is a 30 second
 * 9:16 clip with narration), and every one of them is checkable by measurement.
 * A vision model is the wrong instrument for a question ffprobe answers exactly.
 */
export async function finalTechnicalCheck(input: {
  videoPath: string;
  targetSec: number;
  targetWidth: number;
  targetHeight: number;
  expectAudio: boolean;
}): Promise<FinalCheck> {
  const problems: string[] = [];
  let durationSec = 0;
  let width = 0;
  let height = 0;
  let audio = false;

  try {
    durationSec = await probeDuration(input.videoPath);
    const dims = await probeDimensions(input.videoPath);
    width = dims.width;
    height = dims.height;
    audio = await hasAudio(input.videoPath);
  } catch (err) {
    return {
      ok: false,
      checked: true,
      problems: [`could not probe the finished file: ${String(err).slice(0, 120)}`],
      measured: { durationSec, width, height, audio },
    };
  }

  // A tenth of a second either way is encoder rounding, not a broken promise.
  if (Math.abs(durationSec - input.targetSec) > 0.15) {
    problems.push(
      `duration ${durationSec.toFixed(2)}s does not match the ${input.targetSec.toFixed(2)}s sold`,
    );
  }
  if (width !== input.targetWidth || height !== input.targetHeight) {
    problems.push(
      `dimensions ${width}x${height} do not match the ${input.targetWidth}x${input.targetHeight} format chosen`,
    );
  }
  if (input.expectAudio && !audio) {
    problems.push("no audio track — the clip shipped silent");
  }

  return {
    ok: problems.length === 0,
    checked: true,
    problems,
    measured: { durationSec, width, height, audio },
  };
}
