import { env } from "@/lib/env";
import { assertPublicUrl as guardPublicUrl } from "@/lib/net/public-url";
import type { PostMedia, PostMediaAttachment } from "./post-media";
import { linkedinProxy, type ProxyParameter } from "./linkedin-proxy";

const REST = "https://api.linkedin.com/rest";
const MAX_REDIRECTS = 5;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 10 * 1024 * 1024;

type PublicUrlGuard = (url: string) => Promise<string | null>;

interface Dependencies {
  fetcher?: typeof fetch;
  assertPublicUrl?: PublicUrlGuard;
  wait?: (ms: number) => Promise<void>;
}

export class LinkedInMediaError extends Error {}

function proxyHeaders(contentType = false): ProxyParameter[] {
  return [
    { name: "X-Restli-Protocol-Version", value: "2.0.0", type: "header" },
    { name: "LinkedIn-Version", value: env.linkedinApiVersion, type: "header" },
    ...(contentType ? [{ name: "Content-Type", value: "application/json", type: "header" as const }] : []),
  ];
}

function requireProxyOk<T>(res: { status: number; data?: T }, action: string): T {
  if (res.status >= 200 && res.status < 300) return res.data as T;
  throw new LinkedInMediaError(`${action} failed (${res.status})`);
}

async function errorText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, 240);
}

async function requireOk(res: Response, action: string): Promise<Response> {
  if (res.ok) return res;
  throw new LinkedInMediaError(`${action} failed (${res.status}): ${await errorText(res)}`.slice(0, 300));
}

function maxBytesFor(kind: PostMedia["kind"]): number {
  if (kind === "image") return MAX_IMAGE_BYTES;
  if (kind === "video") return MAX_VIDEO_BYTES;
  return MAX_DOCUMENT_BYTES;
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function downloadPublicAsset(
  rawUrl: string,
  maxBytes: number,
  deps: Required<Pick<Dependencies, "fetcher" | "assertPublicUrl">>,
): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
  let candidate = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    const safeUrl = await deps.assertPublicUrl(candidate);
    if (!safeUrl) throw new LinkedInMediaError("Media must use a resolvable public URL.");

    const res = await deps.fetcher(safeUrl, { redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) throw new LinkedInMediaError("Media URL redirected without a destination.");
      candidate = new URL(location, safeUrl).toString();
      continue;
    }
    await requireOk(res, "Media download");

    const statedLength = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(statedLength) && statedLength > maxBytes) {
      throw new LinkedInMediaError(`Media is too large; this publisher accepts up to ${Math.floor(maxBytes / 1024 / 1024)}MB.`);
    }
    if (!res.body) return { bytes: new Uint8Array(), contentType: res.headers.get("content-type") ?? "", finalUrl: safeUrl };

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new LinkedInMediaError(`Media is too large; this publisher accepts up to ${Math.floor(maxBytes / 1024 / 1024)}MB.`);
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { bytes, contentType: res.headers.get("content-type") ?? "", finalUrl: safeUrl };
  }
  throw new LinkedInMediaError("Media URL redirected too many times.");
}

function assertExpectedType(kind: PostMedia["kind"], contentType: string): void {
  const type = contentType.toLowerCase().split(";", 1)[0].trim();
  if (!type || type === "application/octet-stream") return;
  if (kind === "image" && ["image/jpeg", "image/png", "image/gif"].includes(type)) return;
  if (kind === "image") {
    throw new LinkedInMediaError("LinkedIn images must be JPG, GIF, or PNG files.");
  }
  if (kind === "video" && type === "video/mp4") return;
  if (kind === "video") throw new LinkedInMediaError("LinkedIn videos must be MP4 files.");
  if (kind === "document" && type === "application/pdf") return;
  throw new LinkedInMediaError(`The media URL returned ${type}, not a ${kind} asset.`);
}

async function initializeImage(
  connectedAccountId: string,
  author: string,
  fetcher: typeof fetch,
): Promise<{ uploadUrl: string; urn: string }> {
  const res = await linkedinProxy<{ value?: { uploadUrl?: string; image?: string } }>({
    connectedAccountId,
    endpoint: `${REST}/images?action=initializeUpload`,
    method: "POST",
    parameters: proxyHeaders(true),
    body: { initializeUploadRequest: { owner: author } },
  }, fetcher);
  const body = requireProxyOk(res, "Image upload initialization");
  if (!body.value?.uploadUrl || !body.value.image) {
    throw new LinkedInMediaError("LinkedIn did not return an image upload URL.");
  }
  return { uploadUrl: body.value.uploadUrl, urn: body.value.image };
}

async function initializeDocument(
  connectedAccountId: string,
  author: string,
  fetcher: typeof fetch,
): Promise<{ uploadUrl: string; urn: string }> {
  const res = await linkedinProxy<{ value?: { uploadUrl?: string; document?: string } }>({
    connectedAccountId,
    endpoint: `${REST}/documents?action=initializeUpload`,
    method: "POST",
    parameters: proxyHeaders(true),
    body: { initializeUploadRequest: { owner: author } },
  }, fetcher);
  const body = requireProxyOk(res, "Document upload initialization");
  if (!body.value?.uploadUrl || !body.value.document) {
    throw new LinkedInMediaError("LinkedIn did not return a document upload URL.");
  }
  return { uploadUrl: body.value.uploadUrl, urn: body.value.document };
}

interface VideoUploadInstruction {
  firstByte: number;
  lastByte: number;
  uploadUrl: string;
}

async function uploadVideo(input: {
  connectedAccountId: string;
  author: string;
  media: PostMedia;
  bytes: Uint8Array;
  deps: Required<Pick<Dependencies, "fetcher" | "assertPublicUrl" | "wait">>;
}): Promise<string> {
  const initRes = await linkedinProxy<{
    value?: {
      video?: string;
      uploadToken?: string;
      thumbnailUploadUrl?: string;
      uploadInstructions?: VideoUploadInstruction[];
    };
  }>({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${REST}/videos?action=initializeUpload`,
    method: "POST",
    parameters: proxyHeaders(true),
    body: {
        initializeUploadRequest: {
          owner: input.author,
          fileSizeBytes: input.bytes.byteLength,
          uploadCaptions: false,
          uploadThumbnail: Boolean(input.media.thumbnailUrl),
        },
    },
  }, input.deps.fetcher);
  const init = requireProxyOk(initRes, "Video upload initialization");
  const value = init.value;
  if (!value?.video || !value.uploadToken || !value.uploadInstructions?.length) {
    throw new LinkedInMediaError("LinkedIn did not return complete video upload instructions.");
  }

  const uploadedPartIds: string[] = [];
  for (const part of value.uploadInstructions) {
    const bytes = input.bytes.slice(part.firstByte, part.lastByte + 1);
    if (bytes.byteLength !== part.lastByte - part.firstByte + 1) {
      throw new LinkedInMediaError("LinkedIn requested a video byte range outside the source file.");
    }
    const put = await requireOk(
      await input.deps.fetcher(part.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: requestBody(bytes),
      }),
      "Video part upload",
    );
    const etag = put.headers.get("etag");
    if (!etag) throw new LinkedInMediaError("LinkedIn returned no id for an uploaded video part.");
    uploadedPartIds.push(etag.replace(/^\"|\"$/g, ""));
  }

  if (input.media.thumbnailUrl) {
    if (!value.thumbnailUploadUrl) {
      throw new LinkedInMediaError("LinkedIn did not return a thumbnail upload URL.");
    }
    const thumbnail = await downloadPublicAsset(input.media.thumbnailUrl, MAX_THUMBNAIL_BYTES, input.deps);
    assertExpectedType("image", thumbnail.contentType);
    await requireOk(
      await input.deps.fetcher(value.thumbnailUploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": thumbnail.contentType || "image/jpeg",
          "media-type-family": "STILLIMAGE",
        },
        body: requestBody(thumbnail.bytes),
      }),
      "Video thumbnail upload",
    );
  }

  requireProxyOk(await linkedinProxy({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${REST}/videos?action=finalizeUpload`,
    method: "POST",
    parameters: proxyHeaders(true),
    body: {
        finalizeUploadRequest: {
          video: value.video,
          uploadToken: value.uploadToken,
          uploadedPartIds,
        },
    },
  }, input.deps.fetcher), "Video upload finalization");

  for (let attempt = 0; attempt < 10; attempt++) {
    const statusBody = requireProxyOk(await linkedinProxy<{ status?: string; value?: { status?: string } }>({
      connectedAccountId: input.connectedAccountId,
      endpoint: `${REST}/videos/${encodeURIComponent(value.video)}`,
      method: "GET",
      parameters: proxyHeaders(),
    }, input.deps.fetcher), "Video status check");
    const status = statusBody.status ?? statusBody.value?.status;
    if (status === "AVAILABLE") return value.video;
    if (status === "PROCESSING_FAILED") throw new LinkedInMediaError("LinkedIn could not process the video.");
    if (attempt < 9) await input.deps.wait(1_000);
  }
  throw new LinkedInMediaError("LinkedIn is still processing the video; try publishing again shortly.");
}

function postContent(media: PostMedia, urn: string): { media: Record<string, string> } {
  if (media.kind === "image") {
    return { media: { id: urn, ...(media.altText ? { altText: media.altText.slice(0, 4_086) } : {}) } };
  }
  return {
    media: {
      id: urn,
      title: (media.title || (media.kind === "document" ? "Carousel" : "Video")).slice(0, 100),
    },
  };
}

async function uploadImage(
  media: PostMedia,
  connectedAccountId: string,
  author: string,
  deps: Required<Pick<Dependencies, "fetcher" | "assertPublicUrl">>,
): Promise<{ id: string; altText?: string }> {
  const asset = await downloadPublicAsset(media.url, MAX_IMAGE_BYTES, deps);
  assertExpectedType("image", asset.contentType);
  if (!asset.bytes.byteLength) throw new LinkedInMediaError("Media URL returned an empty file.");
  const initialized = await initializeImage(connectedAccountId, author, deps.fetcher);
  requireProxyOk(await linkedinProxy({
    connectedAccountId,
    endpoint: initialized.uploadUrl,
    method: "PUT",
    binaryBody: { url: asset.finalUrl, content_type: asset.contentType || "application/octet-stream" },
  }, deps.fetcher), "Image upload");
  return {
    id: initialized.urn,
    ...(media.altText ? { altText: media.altText.slice(0, 4_086) } : {}),
  };
}

/** Upload one native asset and create the LinkedIn post that references it. */
export async function publishLinkedInNativePost(
  input: {
    connectedAccountId: string;
    author: string;
    commentary: string;
    media: PostMediaAttachment;
  },
  dependencies: Dependencies = {},
): Promise<{ id: string }> {
  const deps = {
    fetcher: dependencies.fetcher ?? fetch,
    assertPublicUrl: dependencies.assertPublicUrl ?? guardPublicUrl,
    wait: dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  if (Array.isArray(input.media)) {
    if (input.media.length < 2 || input.media.length > 20) {
      throw new LinkedInMediaError("LinkedIn multi-image posts require 2 to 20 images.");
    }
    if (input.media.some((media) => media.kind !== "image")) {
      throw new LinkedInMediaError("LinkedIn multi-image posts support only images.");
    }
    const images = [];
    for (const media of input.media) {
      images.push(await uploadImage(media, input.connectedAccountId, input.author, deps));
    }
    const postRes = await linkedinProxy({
      connectedAccountId: input.connectedAccountId,
      endpoint: `${REST}/posts`,
      method: "POST",
      parameters: proxyHeaders(true),
      body: {
        author: input.author,
        commentary: input.commentary,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: { multiImage: { images } },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
      },
    }, deps.fetcher);
    requireProxyOk(postRes, "LinkedIn post creation");
    return {
      id: postRes.headers?.["x-restli-id"] ?? postRes.headers?.["x-linkedin-id"] ?? "",
    };
  }
  const asset = await downloadPublicAsset(input.media.url, maxBytesFor(input.media.kind), deps);
  assertExpectedType(input.media.kind, asset.contentType);
  if (!asset.bytes.byteLength) throw new LinkedInMediaError("Media URL returned an empty file.");

  let urn: string;
  if (input.media.kind === "image") {
    const initialized = await initializeImage(input.connectedAccountId, input.author, deps.fetcher);
    requireProxyOk(await linkedinProxy({
      connectedAccountId: input.connectedAccountId,
      endpoint: initialized.uploadUrl,
      method: "PUT",
      binaryBody: { url: asset.finalUrl, content_type: asset.contentType || "application/octet-stream" },
    }, deps.fetcher), "Image upload");
    urn = initialized.urn;
  } else if (input.media.kind === "document") {
    const initialized = await initializeDocument(input.connectedAccountId, input.author, deps.fetcher);
    requireProxyOk(await linkedinProxy({
      connectedAccountId: input.connectedAccountId,
      endpoint: initialized.uploadUrl,
      method: "PUT",
      binaryBody: { url: asset.finalUrl, content_type: "application/pdf" },
    }, deps.fetcher), "Document upload");
    urn = initialized.urn;
  } else {
    urn = await uploadVideo({
      connectedAccountId: input.connectedAccountId,
      author: input.author,
      media: input.media,
      bytes: asset.bytes,
      deps,
    });
  }

  const postRes = await linkedinProxy({
    connectedAccountId: input.connectedAccountId,
    endpoint: `${REST}/posts`,
    method: "POST",
    parameters: proxyHeaders(true),
    body: {
        author: input.author,
        commentary: input.commentary,
        visibility: "PUBLIC",
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: postContent(input.media, urn),
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: false,
    },
  }, deps.fetcher);
  requireProxyOk(postRes, "LinkedIn post creation");
  return {
    id: postRes.headers?.["x-restli-id"] ?? postRes.headers?.["x-linkedin-id"] ?? "",
  };
}
