import OpenAI, { toFile } from "openai";
import { env, openaiConfigured, supabaseConfigured } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";

let _client: OpenAI | null = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: env.openaiKey });
  return _client;
}

export type ImageAspect = "vertical" | "square" | "landscape";

const IMAGE_MODEL = "gpt-image-2";

const GPT_IMAGE_SIZE: Record<ImageAspect, "1024x1536" | "1024x1024" | "1536x1024"> = {
  vertical: "1024x1536",
  square: "1024x1024",
  landscape: "1536x1024",
};

export const ASPECT_PIXELS: Record<ImageAspect, { w: number; h: number }> = {
  vertical: { w: 1024, h: 1536 },
  square: { w: 1024, h: 1024 },
  landscape: { w: 1536, h: 1024 },
};

export interface GeneratedImage {
  b64?: string;
  url?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  provider: "gpt-image-2" | "simulated";
}

export const MAX_REFERENCE_ASSETS = 4;

export async function generateImages(input: {
  prompt: string;
  aspect: ImageAspect;
  count: number;
  assetUrls?: string[];
}): Promise<ImageResult> {
  const count = Math.min(Math.max(input.count, 1), 4);
  if (!openaiConfigured) return simulate(input.aspect, count);

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
    console.error("[ai/image] image generate failed, no rungs left:", err);
  }

  throw new Error("All image providers failed");
}

async function downloadReferenceImages(urls: string[]) {
  const picked = urls.slice(0, MAX_REFERENCE_ASSETS);
  const files = await Promise.all(
    picked.map(async (url, i) => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (!res.ok) return null;
        const type = res.headers.get("content-type") ?? "";
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

function simulate(aspect: ImageAspect, count: number): ImageResult {
  const { w, h } = ASPECT_PIXELS[aspect];
  return {
    provider: "simulated",
    images: Array.from({ length: count }, (_, i) => ({
      url: `https://placehold.co/${w}x${h}/EEF0FF/4A45D1/png?text=Preview+image+${i + 1}%0AAdd+OPENAI_API_KEY`,
    })),
  };
}

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
        if (!db) return `data:image/png;base64,${img.b64}`;
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
