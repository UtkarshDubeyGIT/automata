import { env, higgsfieldConfigured } from "@/lib/env";

/**
 * The Higgsfield REST client.
 *
 * Everything describing WHAT can be made — kinds, aspect ratios, durations,
 * prompt seeds, the credit maths — moved to `./specs`, which has no `env` and
 * no network, so the Video Generator screen can render the picker without
 * pulling this file into the browser. Re-exported below: every existing caller
 * still reaches for all of it at this path.
 */
export * from "./specs";

import {
  normalizeDuration,
  promptForTake,
  segmentsForDuration,
  specForKind,
  presetForRatio,
  type AspectRatio,
  type VideoJob,
  type VideoKind,
  type VideoProvider,
} from "./specs";

/**
 * Higgsfield video provider, built against the verified platform contract
 * (github.com/higgsfield-ai/higgsfield-client):
 *
 *   - Auth:    `Authorization: Key <api_key>:<api_secret>`
 *   - Submit:  POST https://platform.higgsfield.ai/<model-path>  (args as body)
 *              -> { request_id, status_url, cancel_url }
 *   - Poll:    GET  https://platform.higgsfield.ai/requests/<id>/status
 *              -> { status: queued|in_progress|completed|failed|nsfw|canceled, ...result }
 *
 * Text prompt -> video is a two-model chain on this account:
 *   1. `higgsfield-ai/soul/standard`  { prompt }             -> keyframe image
 *   2. `higgsfield-ai/dop/standard`   { prompt, image_url }  -> video
 * When the caller supplies an asset image, step 1 is skipped.
 *
 * Without HIGGSFIELD keys the provider returns simulated jobs so the Video
 * Generator screen stays fully functional in preview.
 */
/**
 * Keyframe model. `soul/cinema`, chosen by measurement against the two
 * alternatives this account exposes (GET /models lists the catalogue):
 *
 *   soul/standard    221s. Rendered garbled UI text on a phone screen — the
 *                    exact thing brandVideoHint forbids. Not in the catalogue
 *                    at all any more; it answers as a legacy alias.
 *   soul/v2/standard  57s. Worse: illegible captions across the whole frame,
 *                    malformed hands, and it misread a selfie brief as a
 *                    photograph OF a phone.
 *   soul/cinema       26s. No rendered text anywhere, filmic grade, correct
 *                    read of the brief. Free, and the fastest of the three.
 *
 * Text is the deciding axis, not taste. A generative model that likes drawing
 * captions will fight the no-text instruction on every render, and the
 * keyframe is what all six takes inherit.
 */
const MODEL_IMAGE = "higgsfield-ai/soul/cinema";
const MODEL_VIDEO = "higgsfield-ai/dop/standard";

/** How long create() will wait for the keyframe image before giving up. */
const KEYFRAME_TIMEOUT_MS = 120_000;
const POLL_DELAY_MS = 2_000;

type HfStatus = "queued" | "in_progress" | "completed" | "failed" | "nsfw" | "canceled";

interface HfSubmitResponse {
  request_id: string;
  status_url?: string;
  cancel_url?: string;
}

// Completed payload shapes vary by model — cover the known ones.
interface HfStatusResponse {
  status: HfStatus;
  images?: Array<{ url?: string }>;
  videos?: Array<{ url?: string; thumbnail_url?: string }>;
  video?: { url?: string; thumbnail_url?: string };
  output_url?: string;
  url?: string;
  [key: string]: unknown;
}

function authHeaders(): Record<string, string> {
  const key = env.higgsfieldSecret
    ? `${env.higgsfieldKey}:${env.higgsfieldSecret}`
    : env.higgsfieldKey;
  return {
    Authorization: `Key ${key}`,
    "Content-Type": "application/json",
  };
}

async function submit(model: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${env.higgsfieldBaseUrl}/${model}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Higgsfield submit ${model} failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const data = (await res.json()) as HfSubmitResponse;
  if (!data.request_id) throw new Error(`Higgsfield submit ${model}: no request_id in response`);
  return data.request_id;
}

async function fetchStatus(requestId: string): Promise<HfStatusResponse> {
  const res = await fetch(`${env.higgsfieldBaseUrl}/requests/${requestId}/status`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Higgsfield status failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as HfStatusResponse;
}

function extractImageUrl(d: HfStatusResponse): string | undefined {
  return d.images?.[0]?.url ?? d.output_url ?? d.url;
}

function extractVideoUrl(d: HfStatusResponse): string | undefined {
  return d.videos?.[0]?.url ?? d.video?.url ?? d.output_url ?? d.url;
}

function extractThumbnail(d: HfStatusResponse): string | undefined {
  return d.videos?.[0]?.thumbnail_url ?? d.video?.thumbnail_url ?? d.images?.[0]?.url;
}

function mapStatus(s: HfStatus): VideoJob["status"] {
  switch (s) {
    case "queued":
      return "queued";
    case "in_progress":
      return "processing";
    case "completed":
      return "completed";
    default:
      return "failed"; // failed | nsfw | canceled
  }
}

/** Poll a request until it reaches a terminal state or the deadline passes. */
async function waitForCompletion(requestId: string, timeoutMs: number): Promise<HfStatusResponse> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const d = await fetchStatus(requestId);
    if (d.status === "completed") return d;
    if (d.status === "failed" || d.status === "nsfw" || d.status === "canceled") {
      throw new Error(`Higgsfield request ${requestId} ended: ${d.status}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`Higgsfield request ${requestId} timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
  }
}

/**
 * What one DoP take costs at the provider, in THEIR credits.
 *
 * From the account's own catalogue (GET /models, 2026-08-26):
 *   higgsfield-ai/dop/standard      9.0    <- what we render with
 *   higgsfield-ai/dop/turbo         6.5
 *   higgsfield-ai/dop/lite/*        2.0
 *   higgsfield-ai/soul/cinema       0.0    <- keyframes are free
 *   higgsfield-ai/soul/v2/standard  0.0
 *   higgsfield-ai/popcorn/auto      1.472
 *
 * Recorded per generation so repricing later is done against measured spend
 * rather than a guess. Note what this makes visible: keyframes cost nothing, so
 * generating one per shot instead of one per clip is free at the provider — the
 * whole provider bill is takes.
 */
export const PROVIDER_CREDITS_PER_TAKE = 9;

/** The keyframe model charges nothing on this account; stated so it is not assumed. */
export const PROVIDER_CREDITS_PER_KEYFRAME = 0;

/**
 * Generate one keyframe still and return its URL.
 *
 * Split out of `create()` so the v2 pipeline can draw a frame PER SHOT while
 * still going through exactly the model, polling and extraction that the
 * single-keyframe path uses. Throws on failure — the caller decides whether a
 * missing keyframe means "reuse the master" or "fail the step".
 */
export async function generateKeyframe(
  prompt: string,
  ratio: AspectRatio,
): Promise<string> {
  if (!higgsfieldConfigured) {
    throw new Error("Higgsfield not configured");
  }
  const requestId = await submit(MODEL_IMAGE, { prompt, aspect_ratio: ratio });
  const done = await waitForCompletion(requestId, KEYFRAME_TIMEOUT_MS);
  const url = extractImageUrl(done);
  if (!url) throw new Error("Higgsfield keyframe completed but returned no image url");
  return url;
}

/**
 * Submit one take and return its request id. Does not wait — takes render for
 * minutes and the whole point of submitting them together is that they render
 * concurrently while nothing blocks on them.
 */
export async function submitTake(input: {
  prompt: string;
  imageUrl: string;
  durationSec: number;
}): Promise<string> {
  return submit(MODEL_VIDEO, {
    prompt: input.prompt,
    image_url: input.imageUrl,
    duration: input.durationSec,
  });
}

class HiggsfieldProvider implements VideoProvider {
  name = "higgsfield";
  live = higgsfieldConfigured;

  async create(input: {
    kind: VideoKind;
    prompt: string;
    visualPrompt?: string;
    assetUrl?: string;
    aspectRatio?: AspectRatio;
    durationSec?: number;
  }): Promise<VideoJob> {
    const spec = specForKind(input.kind);
    const ratio = input.aspectRatio ?? spec.defaultAspect;
    const preset = presetForRatio(ratio);
    // The target length for the finished clip. One request cannot deliver it
    // (the model always returns ~5.4s), so this is what the assembly chain in
    // /api/video/status builds towards — take by take.
    const duration = normalizeDuration(input.durationSec ?? spec.defaultDurationSec);

    // The prompt actually sent to the models = the user's words, grounded by
    // the type's visual style and the chosen framing. Storing/returning the
    // raw prompt (below) keeps history readable.
    // Two models, two prompts. The image model gets the look; the video model
    // gets the motion and inherits the look from the keyframe it animates.
    const scene = (input.visualPrompt ?? input.prompt).trim();
    const keyframePrompt = `${scene} ${spec.keyframe} ${preset.frame}`.trim();

    if (!this.live) {
      return simulate(input.kind, input.prompt, undefined, "processing", ratio, duration);
    }

    // 1. Keyframe: caller-supplied asset, or generate one from the prompt.
    //    The keyframe sets the output dimensions, so aspect_ratio is applied
    //    here (Higgsfield platform accepts `aspect_ratio`, e.g. "9:16"); the
    //    video model then inherits the keyframe's shape.
    //
    //    A supplied asset skips this step, and with it every instruction that
    //    only exists inside `keyframePrompt` — the scene, the type's look, the
    //    framing. That is the correct reading of "animate MY product shot",
    //    but it used to mean the request carried nothing else either: the take
    //    prompts were a canned motion string, so the finished clip was
    //    identical no matter what was typed or picked. Two things now stop
    //    that. The scene rides on every take prompt below, and the assembly
    //    step conforms the cut to the chosen format (see stitch.ts), so the
    //    asset decides what is IN frame and never what the frame IS.
    let imageUrl = input.assetUrl;
    let keyframeGenerated = false;
    if (!imageUrl) {
      const imageReq = await submit(MODEL_IMAGE, { prompt: keyframePrompt, aspect_ratio: ratio });
      const done = await waitForCompletion(imageReq, KEYFRAME_TIMEOUT_MS);
      imageUrl = extractImageUrl(done);
      if (!imageUrl) throw new Error("Higgsfield keyframe completed but returned no image url");
      keyframeGenerated = true;
    }

    // 2. Animate it — one request per take, all from this keyframe, submitted
    //    together so they render concurrently rather than one after another.
    //    `duration` is still sent for the day the model starts honouring it,
    //    but nothing depends on that.
    //
    //    Take 0's request id becomes the client-facing job id for the whole
    //    clip, so polling never has to know how many takes there were.
    const takeCount = segmentsForDuration(duration);
    const takePrompts = Array.from({ length: takeCount }, (_, i) =>
      promptForTake(scene, input.kind, i),
    );
    const requestIds = await Promise.all(
      takePrompts.map((prompt) =>
        submit(MODEL_VIDEO, {
          prompt,
          image_url: imageUrl,
          duration,
        }),
      ),
    );

    return {
      id: requestIds[0],
      status: "queued",
      kind: input.kind,
      prompt: input.prompt,
      thumbnailUrl: imageUrl,
      aspectRatio: ratio,
      durationSec: duration,
      // What was ACTUALLY sent, never what was merely composed. When an asset
      // supplied the keyframe, `keyframePrompt` was built and then thrown away
      // — recording it anyway is how a prompt that reached no model at all
      // still looked, in the database, like the prompt we shot.
      providerPrompt: keyframeGenerated
        ? `${keyframePrompt}\n\n[takes] ${takePrompts[0]}`
        : `[keyframe supplied by caller]\n\n[takes] ${takePrompts[0]}`,
      takes: requestIds.map((requestId, index) => ({ index, requestId })),
      progress: { done: 0, total: takeCount },
      createdAt: new Date().toISOString(),
    };
  }

  async status(id: string, kind: VideoKind = "ugc", prompt = ""): Promise<VideoJob> {
    if (!this.live) return simulate(kind, prompt, id, "completed");
    const d = await fetchStatus(id);
    return {
      id,
      status: mapStatus(d.status),
      kind,
      prompt,
      url: d.status === "completed" ? extractVideoUrl(d) : undefined,
      thumbnailUrl: extractThumbnail(d),
      createdAt: new Date().toISOString(),
    };
  }
}

function simulate(
  kind: VideoKind,
  prompt: string,
  id?: string,
  status: VideoJob["status"] = "processing",
  aspectRatio: AspectRatio = specForKind(kind).defaultAspect,
  durationSec: number = specForKind(kind).defaultDurationSec,
): VideoJob {
  return {
    id: id ?? `sim_${Math.random().toString(36).slice(2, 10)}`,
    status,
    kind,
    prompt,
    url:
      status === "completed"
        ? "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
        : undefined,
    aspectRatio,
    durationSec,
    createdAt: new Date().toISOString(),
  };
}

export const videoProvider: VideoProvider = new HiggsfieldProvider();
