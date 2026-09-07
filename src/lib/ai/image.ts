import OpenAI, { toFile } from "openai";
import { env, openaiConfigured, supabaseConfigured } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import { setupNotice } from "@/lib/setup-notice";

let _client: OpenAI | null = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: env.openaiKey });
  return _client;
}

/**
 * Image sizes are defined by DOWNSTREAM USE, not by the model. Every preset
 * maps to a video-ready aspect so any generated image can be handed straight
 * to the Video Generator as a keyframe (Higgsfield DoP animates the keyframe
 * at the image's own aspect):
 *
 *   vertical  → Reels / Shorts / TikTok — matches the Video Generator's 9:16 canvas
 *   square    → feed posts / carousels
 *   landscape → YouTube / ads / link previews (16:9 targets)
 */
export type ImageAspect = "vertical" | "square" | "landscape";

/**
 * The image model behind every rung below.
 *
 * `gpt-image-1` until OpenAI scheduled it for shutdown on 23 October 2026. The
 * swap to `gpt-image-2` is a rename everywhere except one place: it REJECTS
 * `input_fidelity` outright — HTTP 400 `invalid_input_fidelity_model`, not a
 * silently ignored field — so the `input_fidelity: "high"` the edit rung used
 * to send had to be deleted rather than carried over. Nothing is lost by that:
 * gpt-image-2 processes every reference image at high fidelity by default,
 * which is exactly what the parameter was asking for.
 *
 * Deliberately unpinned, matching how the text models are named elsewhere in
 * this codebase. Pin the `gpt-image-2-2026-04-21` snapshot here if a future
 * change needs output to be reproducible across snapshots.
 */
const IMAGE_MODEL = "gpt-image-2";

/** Native sizes the model accepts (portrait/square/landscape). */
const GPT_IMAGE_SIZE: Record<ImageAspect, "1024x1536" | "1024x1024" | "1536x1024"> = {
  vertical: "1024x1536",
  square: "1024x1024",
  landscape: "1536x1024",
};

/** Pixel dimensions per aspect (same sizes) — used for placeholders/UI. */
export const ASPECT_PIXELS: Record<ImageAspect, { w: number; h: number }> = {
  vertical: { w: 1024, h: 1536 },
  square: { w: 1024, h: 1024 },
  landscape: { w: 1536, h: 1024 },
};

export interface GeneratedImage {
  /** Base64 PNG when produced by a live model; absent for simulated output. */
  b64?: string;
  /** Direct URL for simulated output (no key configured). */
  url?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  provider: "gpt-image-2" | "simulated";
}

/** Max reference assets forwarded to the model per generation. */
export const MAX_REFERENCE_ASSETS = 4;

/**
 * Generate `count` on-brand images.
 *
 * Provider chain (never throws before exhausting all options):
 *   1. EDIT with the workspace's brand assets as reference images (product/logo
 *      stays the hero — the model grounds on them at high fidelity by default)
 *   2. GENERATE (no usable references)
 *   3. simulated placeholders when OPENAI_API_KEY is absent
 *
 * A dall-e-3 rung sat under 2 for orgs without GPT-image access. OpenAI
 * removed the model from the API on 12 May 2026, so every call it received
 * raised — the rung could not return an image, only delay the throw above by
 * one failed round trip per requested image. Deleted rather than repointed:
 * the two rungs above it are the same family, so a third rung is only worth
 * having once there is a model from a DIFFERENT family to put on it.
 */
export async function generateImages(input: {
  prompt: string;
  aspect: ImageAspect;
  count: number;
  /** Public URLs of brand assets to ground the image in (images only). */
  assetUrls?: string[];
}): Promise<ImageResult> {
  const count = Math.min(Math.max(input.count, 1), 4);
  if (!openaiConfigured) return simulate(input.aspect, count);

  // 1. Reference-grounded edit when brand assets exist.
  const refs = await downloadReferenceImages(input.assetUrls ?? []);
  if (refs.length > 0) {
    try {
      const res = await client().images.edit({
        model: IMAGE_MODEL,
        image: refs,
        prompt: input.prompt,
        n: count,
        size: GPT_IMAGE_SIZE[input.aspect],
        quality: "medium",
      });
      const images = (res.data ?? [])
        .map((d) => ({ b64: d.b64_json }))
        .filter((d): d is { b64: string } => !!d.b64);
      if (images.length > 0) return { images, provider: "gpt-image-2" };
    } catch (err) {
      console.error("[ai/image] image edit failed, falling back:", err);
    }
  }

  // 2. Plain generation.
  try {
    const res = await client().images.generate({
      model: IMAGE_MODEL,
      prompt: input.prompt,
      n: count,
      size: GPT_IMAGE_SIZE[input.aspect],
      quality: "medium",
    });
    const images = (res.data ?? [])
      .map((d) => ({ b64: d.b64_json }))
      .filter((d): d is { b64: string } => !!d.b64);
    if (images.length > 0) return { images, provider: "gpt-image-2" };
  } catch (err) {
    console.error("[ai/image] image generate failed, falling back to placeholders:", err);
  }

  // 3. Fallback placeholders so downstream tasks (posts, previews) aren't blocked.
  return simulate(input.aspect, count);
}

/** Download public image URLs and convert to OpenAI File objects for multi-image input. */
async function downloadReferenceImages(urls: string[]) {
  const targets = urls.slice(0, MAX_REFERENCE_ASSETS);
  const files = await Promise.all(
    targets.map(async (url, i) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "image/jpeg";
        if (!type.startsWith("image/")) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
        return await toFile(buf, `asset-${i}.${ext}`, { type });
      } catch {
        return null;
      }
    }),
  );
  return files.filter((f): f is NonNullable<typeof f> => f !== null);
}

/** Placeholder output so the studio stays fully functional without a key. */
function simulate(aspect: ImageAspect, count: number): ImageResult {
  const { w, h } = ASPECT_PIXELS[aspect];
  return {
    provider: "simulated",
    images: Array.from({ length: count }, (_, i) => ({
      // The caption is baked into the placeholder image itself, so an operator
      // hint here would be rendered right into the studio for a customer.
      url: `https://placehold.co/${w}x${h}/EEF0FF/4A45D1/png?text=Preview+image+${i + 1}${setupNotice("", "%0AAdd+OPENAI_API_KEY")}`,
    })),
  };
}

/**
 * Put generated images somewhere their URL will still resolve tomorrow.
 *
 * The model hands back base64; every consumer needs a link it can put in a
 * post, a content row or a `social_post` step. Provider URLs expire, so the
 * bytes are archived into our own `content-images` bucket and the public URL is
 * what travels onward.
 *
 * Returns one entry per input, `null` where that image could not be archived —
 * callers decide whether a partial result is worth keeping or worth refunding.
 *
 * Two passthroughs are deliberate, not fallbacks worth removing: a simulated
 * image already IS a URL (nothing to store), and an install with no Supabase
 * gets a data: URI so a zero-backend preview still renders its own output.
 */
export async function archiveImages(
  images: GeneratedImage[],
  workspaceId: string | null,
): Promise<(string | null)[]> {
  return Promise.all(
    images.map(async (img, i) => {
      if (img.url) return img.url;
      if (!img.b64) return null;
      if (!supabaseConfigured || !workspaceId) return `data:image/png;base64,${img.b64}`;
      try {
        const db = createAdminClient();
        const path = `${workspaceId}/${Date.now()}-${i}.png`;
        const { error } = await db.storage
          .from("content-images")
          .upload(path, Buffer.from(img.b64, "base64"), {
            contentType: "image/png",
            upsert: true,
          });
        if (error) throw error;
        return db.storage.from("content-images").getPublicUrl(path).data.publicUrl;
      } catch (err) {
        console.error("[ai/image] archive failed:", err);
        return null;
      }
    }),
  );
}
