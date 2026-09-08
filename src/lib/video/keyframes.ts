import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import { createAdminClient } from "@/lib/supabase/server";
import { probeDimensions } from "@/lib/video/probe";
import { generateImages, type ImageAspect } from "@/lib/ai/image";
import { openaiConfigured } from "@/lib/env";
import { brandVideoHint, type BrandProfile } from "@/lib/brand";
import {
  generateKeyframe,
  presetForRatio,
  specForKind,
  type AspectRatio,
  type VideoKind,
} from "@/lib/video/higgsfield";
import type { Shot, VideoPlan } from "@/lib/video/plan";

const exec = promisify(execFile);

/**
 * One intentional still per shot — that all look like the same film.
 *
 * The obvious implementation is one text-to-image call per shot. It does not
 * work, and the reason is worth stating because it is not a tuning problem: the
 * image models on this account are `text2image` ONLY. There is no reference
 * input and no edit endpoint (verified against the account's own catalogue —
 * soul/cinema, soul/v2/standard and popcorn/auto all report
 * `operation_type: ["text2image"]`). Six independent text prompts, however
 * carefully worded, produce six different people in six different rooms. A
 * "consistent" wardrobe description gets you a different person wearing a
 * similar jacket.
 *
 * So consistency has to come from an actual reference image, which means:
 *
 *   1. ONE master frame from Soul, establishing the person, the place, the
 *      wardrobe, the light and the grade. This is the creator frame.
 *   2. Every other shot DERIVED from it by an image-EDIT model that does accept
 *      a reference — the image-EDIT rung in lib/ai/image.ts, which this codebase
 *      already uses to keep a product recognisable across generated images and
 *      which grounds on its references at high fidelity.
 *   3. Where a derivation cannot be trusted — no OpenAI key, a failed edit —
 *      the shot REUSES the master frame. That is the old behaviour, so the
 *      worst case here is exactly what shipped before, and never six strangers.
 *
 * Keyframes are free at the provider (see PROVIDER_CREDITS_PER_KEYFRAME), so
 * step 1 costs nothing and step 2 is priced in OpenAI image calls, not video
 * credits. The expensive thing is the take, and nothing here spends one.
 */

/** Where each shot's opening frame lives, and how it got there. */
export interface KeyframeSet {
  /** The creator frame every other shot is derived from. */
  masterUrl: string;
  /** Per shot index: the frame to animate. Never empty — falls back to master. */
  byShot: string[];
  /** How many shots got their own derived frame rather than the master. */
  derived: number;
  /** Shots that fell back, for the metrics record. */
  reused: number;
  /** How many times the master had to be drawn. */
  masterAttempts: number;
  /** Defects still present in the master we settled on, if any. */
  masterProblems: string[];
}

const EDIT_TIMEOUT_MS = 120_000;

/** Video ratios map onto the three shapes the image models offer. */
function imageAspect(ratio: AspectRatio): ImageAspect {
  if (ratio === "16:9") return "landscape";
  if (ratio === "1:1") return "square";
  return "vertical"; // 9:16 and 4:5 are both portrait
}

/**
 * Centre-crop a derived frame to the video's real aspect ratio.
 *
 * The edit model has no 9:16 size — its "vertical" is 1024x1536,
 * which is 2:3 (0.667) against a 9:16 target of 0.5625. The master comes from
 * Soul at the true ratio, so without this the two shots enter assembly in
 * DIFFERENT shapes: `conformFilter` centre-crops both to 1080x1920, taking
 * about 15% more off the sides of the derived frame than the master. The
 * subject is then framed noticeably tighter on one shot than the other, which
 * reads as a continuity error in a cut that is otherwise consistent.
 *
 * Cropping here instead means DoP animates a frame that is already the right
 * shape, so what it renders is what gets delivered. Best-effort: a crop that
 * fails returns the original, which is what shipped before.
 */
async function cropToRatio(png: Buffer, ratio: AspectRatio): Promise<Buffer> {
  const target = presetForRatio(ratio);
  const aspect = target.width / target.height;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-kf-"));
  try {
    const src = path.join(dir, "in.png");
    const out = path.join(dir, "out.png");
    await fs.writeFile(src, png);
    const { width, height } = await probeDimensions(src);
    // Already the right shape, to within a pixel of rounding.
    if (Math.abs(width / height - aspect) < 0.005) return png;
    const cropW = Math.min(width, Math.round(height * aspect));
    const cropH = Math.min(height, Math.round(width / aspect));
    await exec(
      "ffmpeg",
      ["-y", "-v", "error", "-i", src,
        "-vf", `crop=${cropW}:${cropH}:(iw-${cropW})/2:(ih-${cropH})/2`,
        out],
      { timeout: 60_000 },
    );
    return await fs.readFile(out);
  } catch (err) {
    console.error("[video/keyframes] crop failed, keeping original shape:", err);
    return png;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Store a generated frame and return its public URL. */
async function storeFrame(
  b64: string,
  workspaceId: string,
  jobId: string,
  name: string,
): Promise<string | null> {
  try {
    const db = createAdminClient();
    const path = `${workspaceId}/${jobId}/${name}.png`;
    const { error } = await db.storage
      .from("videos")
      .upload(path, Buffer.from(b64, "base64"), {
        contentType: "image/png",
        upsert: true,
      });
    if (error) {
      console.error("[video/keyframes] frame upload failed:", error.message);
      return null;
    }
    return db.storage.from("videos").getPublicUrl(path).data.publicUrl;
  } catch (err) {
    console.error("[video/keyframes] frame upload threw:", err);
    return null;
  }
}

/** Copy a remote frame into our bucket. Returns null if it could not be. */
async function mirrorFrame(
  url: string,
  workspaceId: string,
  jobId: string,
): Promise<string | null> {
  try {
    const res = await fetchPublicUrl(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) return null;
    return await storeFrame(buf.toString("base64"), workspaceId, jobId, "keyframe-master");
  } catch (err) {
    console.error("[video/keyframes] master mirror failed:", err);
    return null;
  }
}

/**
 * The master frame prompt.
 *
 * Built from the style anchor rather than from a single shot, because this
 * frame's job is to define what every LATER shot must match. Anchoring it on
 * shot 0's action would bake that action into the reference, and every derived
 * frame would inherit it.
 */
function masterPrompt(input: {
  plan: VideoPlan;
  kind: VideoKind;
  ratio: AspectRatio;
  profile: BrandProfile | null;
}): string {
  const spec = specForKind(input.kind);
  const preset = presetForRatio(input.ratio);
  const opening = input.plan.shots[0]?.visual ?? "";
  return [
    input.plan.styleAnchor,
    opening,
    spec.keyframe,
    preset.frame,
    brandVideoHint(input.profile),
  ]
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Derive one shot's frame from the master.
 *
 * The instruction leads with what must NOT change. An edit model given "a woman
 * holding the product by a window" treats every noun as negotiable; given "the
 * same person, same clothes, same room as the reference — now she does X" it
 * treats the reference as the subject and the sentence as the change.
 */
async function deriveFrame(input: {
  shot: Shot;
  masterUrl: string;
  productAssetUrl?: string | null;
  ratio: AspectRatio;
  profile: BrandProfile | null;
}): Promise<string | null> {
  const useProduct = input.shot.kind === "product_asset" && !!input.productAssetUrl;
  const refs = useProduct
    ? [input.masterUrl, input.productAssetUrl as string]
    : [input.masterUrl];

  const prompt = [
    "Keep the SAME person, face, hair, wardrobe, location, lighting and colour",
    "grade as the first reference image. This is the same shot from the same",
    "shoot, moments later — not a new scene and not a different person.",
    useProduct
      ? "The product in frame is the one in the second reference image: match its" +
        " exact shape, colour, proportions and markings. Do not redesign it."
      : "",
    `Now show: ${input.shot.visual}`,
    input.shot.direction ? `The moment: ${input.shot.direction}` : "",
    // Same prohibition the video model gets — branding is composited, never drawn.
    "Do not render any logo, wordmark, brand name, watermark, subtitles or other",
    "text anywhere in the frame.",
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const res = await Promise.race([
      generateImages({
        prompt,
        aspect: imageAspect(input.ratio),
        count: 1,
        assetUrls: refs,
      }),
      new Promise<null>((r) => setTimeout(() => r(null), EDIT_TIMEOUT_MS)),
    ]);
    // `simulated` means no API key — a placeholder is not a keyframe, and
    // animating one would produce a video of a grey box with text on it.
    if (!res || res.provider === "simulated") return null;
    return res.images[0]?.b64 ?? null;
  } catch (err) {
    console.error(`[video/keyframes] shot ${input.shot.index} derivation failed:`, err);
    return null;
  }
}

/**
 * Build the whole keyframe set.
 *
 * Derivations run in PARALLEL: they are independent edits of one reference, and
 * a six-shot clip would otherwise spend six sequential image calls before a
 * single take is submitted — minutes of latency added to the front of every
 * generation for no reason.
 *
 * Throws only when the master frame itself cannot be made. Everything after
 * that degrades to reusing the master, because a clip built from one good frame
 * is the product that shipped yesterday and a clip built from no frame is
 * nothing at all.
 */
export async function buildKeyframes(input: {
  plan: VideoPlan;
  kind: VideoKind;
  ratio: AspectRatio;
  profile: BrandProfile | null;
  workspaceId: string;
  jobId: string;
  productAssetUrl?: string | null;
  /**
   * A frame supplied by the caller — the user attached an asset and asked for
   * the video to be built from it. It becomes the master, and Soul is skipped
   * entirely: the whole point of attaching an image is that the clip starts
   * from THAT image.
   */
  suppliedMasterUrl?: string | null;
  /**
   * Check the master frame before anything is derived from it.
   *
   * The master is the one frame that cannot fall back to anything: shot 0
   * animates it directly, and every other shot is derived from it, so a defect
   * here is a defect in the whole clip. A real run produced a master with a
   * model-drawn watermark in the corner, which the check caught and the
   * pipeline then rendered anyway — twice, because re-rendering the shot
   * animates the same bad frame.
   *
   * Keyframes cost nothing at the provider, so the right response is simply to
   * draw another one. Supplied by the caller so validation stays out of this
   * module's imports.
   */
  validateMaster?: (url: string) => Promise<{ ok: boolean; problems: string[]; checked: boolean }>;
}): Promise<KeyframeSet> {
  const shots = input.plan.shots.filter(
    (s) => s.kind === "generated" || s.kind === "product_asset",
  );

  const basePrompt = masterPrompt({
    plan: input.plan,
    kind: input.kind,
    ratio: input.ratio,
    profile: input.profile,
  });

  let masterUrl = input.suppliedMasterUrl || (await generateKeyframe(basePrompt, input.ratio));
  let masterAttempts = 1;
  let masterProblems: string[] = [];

  // Draw it again if it came back defective. Bounded at one retry: a second
  // failure is a signal about the brief rather than bad luck, and the clip is
  // better served by shipping a flawed frame than by looping.
  if (!input.suppliedMasterUrl && input.validateMaster) {
    const verdict = await input.validateMaster(masterUrl);
    if (verdict.checked && !verdict.ok) {
      masterProblems = verdict.problems;
      console.log(
        `[video/keyframes] master rejected (${verdict.problems.join("; ")}) — redrawing`,
      );
      // Name the actual defects. A generic "no watermarks" line is already in
      // every prompt via brandVideoHint and this frame ignored it; repeating
      // the instruction unchanged would most likely produce the same frame.
      const retryPrompt =
        `${basePrompt} Critical corrections: ${verdict.problems.join(" ")} ` +
        `Absolutely no watermark, signature, stamp, logo or overlay graphic ` +
        `anywhere in the frame, and nothing at all in the corners.`;
      const second = await generateKeyframe(retryPrompt, input.ratio).catch((err) => {
        console.error("[video/keyframes] master redraw failed:", err);
        return null;
      });
      if (second) {
        masterAttempts = 2;
        const recheck = await input.validateMaster(second);
        // Keep the redraw when it is clean, or when we could not tell — the
        // first frame is known bad, so an unverified replacement is no worse.
        if (!recheck.checked || recheck.ok) {
          masterUrl = second;
          masterProblems = [];
        } else {
          // `masterProblems` already holds the FIRST frame's defects, and the
          // first frame is what we keep — so it must not be overwritten with
          // the redraw's. It was, and the consequence was not cosmetic: the
          // value is persisted onto the row and is the ONLY input to
          // `inheritedFromKeyframe`, the guard that stops a shot being
          // re-rendered for a defect baked into the frame it animates. Fed the
          // discarded frame's complaints, the guard compared "legible text on
          // shirt" against a rendered shot's "legible branding on the hat",
          // found one word in common where it needs two, and paid 9 provider
          // credits to reproduce a frame it already knew was bad.
          console.log(
            `[video/keyframes] redraw still rejected (${recheck.problems.join("; ")}) — ` +
              `keeping the first, whose own defects stand (${masterProblems.join("; ")})`,
          );
        }
      }
    }
  }

  // Mirror the master into our own storage.
  //
  // What `generateKeyframe` returns is a Higgsfield CDN url, and the row keeps
  // it as `thumbnail_url` — the poster frame history renders. The same argument
  // that makes finished clips get archived applies here: a provider CDN link is
  // not something to still be serving next month. It is also the reference
  // every derived frame was built from, so it is the one image that explains
  // why a clip looks the way it does.
  //
  // Best-effort: a failed mirror keeps the provider url, which still works now.
  if (!input.suppliedMasterUrl) {
    const mirrored = await mirrorFrame(masterUrl, input.workspaceId, input.jobId);
    if (mirrored) masterUrl = mirrored;
  }

  // Every shot starts pointing at the master; a successful derivation replaces
  // its entry. Written this way so a partial failure cannot leave a hole.
  const byShot: string[] = input.plan.shots.map(() => masterUrl);

  // Shot 0 keeps the master: it is the frame the master was drawn to be, so
  // deriving it would spend an edit to reproduce what we already have.
  //
  // Hoisted above the key check because it is also the denominator for
  // `reused`, which is documented as "shots that FELL BACK". Counting from
  // `shots` instead put shot 0 in that number, so a clip where nothing went
  // wrong still reported one fallback — and since shot 0 is a generated shot in
  // essentially every clip, the metric over-reported by exactly one on every
  // single generation. The whole point of the v2 flag is measuring this
  // pipeline before repricing it, and that is one of the numbers being read.
  const toDerive = shots.filter((s) => s.index !== 0);

  if (!openaiConfigured) {
    console.log(
      "[video/keyframes] no OPENAI_API_KEY — every shot reuses the master frame",
    );
    return {
      masterUrl,
      byShot,
      derived: 0,
      reused: toDerive.length,
      masterAttempts,
      masterProblems,
    };
  }

  const results = await Promise.all(
    toDerive.map(async (shot) => {
      const b64 = await deriveFrame({
        shot,
        masterUrl,
        productAssetUrl: input.productAssetUrl,
        ratio: input.ratio,
        profile: input.profile,
      });
      if (!b64) return { index: shot.index, url: null };
      const cropped = await cropToRatio(Buffer.from(b64, "base64"), input.ratio);
      const url = await storeFrame(
        cropped.toString("base64"),
        input.workspaceId,
        input.jobId,
        `keyframe-${shot.index}`,
      );
      return { index: shot.index, url };
    }),
  );

  let derived = 0;
  for (const r of results) {
    if (r.url) {
      byShot[r.index] = r.url;
      derived += 1;
    }
  }

  const reused = toDerive.length - derived;
  console.log(
    `[video/keyframes] ${derived} derived, ${reused} reused the master frame`,
  );
  return { masterUrl, byShot, derived, reused, masterAttempts, masterProblems };
}
