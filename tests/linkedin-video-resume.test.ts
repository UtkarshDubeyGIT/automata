import { strict as assert } from "node:assert";
import { test } from "node:test";
import { LinkedInMediaError, publishLinkedInNativePost } from "@/lib/social/linkedin-media";

/**
 * W15 — a slow LinkedIn video must not be re-uploaded from scratch.
 *
 * The poll budget was ten attempts one second apart. A 30-second clip — exactly
 * what `video.generate` produces — routinely takes longer, so timing out was the
 * NORMAL case. The throw discarded a fully uploaded, finalised asset, and the
 * publisher retried from the first byte: up to five orphaned videos on the
 * customer's account and up to 500MB of redundant upload, for a post that failed
 * anyway.
 *
 * Two properties fix it, and both are pinned here:
 *   1. Running out of patience is a DEFERRAL that hands back the video URN.
 *   2. Given that URN, the next attempt uploads nothing at all.
 *
 * Plus the cheaper lesson: a thumbnail that cannot be fetched must be discovered
 * BEFORE the video goes up, not after.
 */

function response(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const responseBody =
    body == null
      ? null
      : typeof body === "string" || ArrayBuffer.isView(body)
        ? (body as BodyInit)
        : JSON.stringify(body);
  return new Response(responseBody, { status: init.status ?? 200, headers: init.headers });
}

const VIDEO: { kind: "video"; url: string } = {
  kind: "video",
  url: "https://cdn.test/clip.mp4",
};

/** Never AVAILABLE — the transcode that outlasts our patience. */
function stillProcessingFetcher(calls: string[]): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === VIDEO.url) {
      return response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "video/mp4", "content-length": "4" },
      });
    }
    if (url === "https://upload.linkedin.test/part-1") {
      return response(null, { status: 200, headers: { etag: '"part-etag"' } });
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/videos?action=initializeUpload")) {
        return response({
          status: 200,
          data: {
            value: {
              video: "urn:li:video:slow",
              uploadToken: "tok",
              uploadInstructions: [
                { firstByte: 0, lastByte: 3, uploadUrl: "https://upload.linkedin.test/part-1" },
              ],
            },
          },
        });
      }
      if (request.endpoint.endsWith("action=finalizeUpload")) {
        return response({ status: 200, data: {} });
      }
      if (request.endpoint.includes("/videos/")) {
        return response({ status: 200, data: { status: "PROCESSING" } });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}

test("a video that outlasts the poll budget defers with its URN instead of being thrown away", async () => {
  const calls: string[] = [];
  const waits: number[] = [];

  const err = await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:person:1",
      commentary: "A clip.",
      media: VIDEO,
    },
    {
      fetcher: stillProcessingFetcher(calls),
      assertPublicUrl: async (url) => url,
      wait: async (ms) => {
        waits.push(ms);
      },
    },
  ).then(
    () => null,
    (e: unknown) => e,
  );

  assert.ok(err instanceof LinkedInMediaError);
  assert.equal(err.retry, "defer", "waiting on a transcode is not a failure");
  assert.equal(err.resume?.linkedinVideoUrn, "urn:li:video:slow");

  // The old budget was nine seconds flat. Backing off has to actually buy time.
  const budgetMs = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(budgetMs >= 60_000, `poll budget was only ${budgetMs}ms`);
});

test("resuming with a known URN uploads nothing — it only waits", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.includes("/videos/")) {
        return response({ status: 200, data: { status: "AVAILABLE" } });
      }
      if (request.endpoint.endsWith("/posts")) {
        return response({ status: 201, data: {}, headers: { "x-restli-id": "urn:li:share:9" } });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const result = await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:person:1",
      commentary: "A clip.",
      media: VIDEO,
      resumeVideoUrn: "urn:li:video:slow",
    },
    { fetcher, assertPublicUrl: async (url) => url },
  );

  assert.equal(result.id, "urn:li:share:9");
  assert.ok(
    !calls.includes(VIDEO.url),
    "the source video must not be downloaded again on a resume",
  );
  assert.ok(
    !calls.some((url) => url.includes("upload.linkedin.test")),
    "not one byte may be re-uploaded",
  );
});

test("an unfetchable thumbnail fails before the video is uploaded, not after", async () => {
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url === VIDEO.url) {
      return response(new Uint8Array([1, 2, 3, 4]), {
        headers: { "content-type": "video/mp4", "content-length": "4" },
      });
    }
    if (url === "https://cdn.test/missing-thumb.jpg") return response("gone", { status: 404 });
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/videos?action=initializeUpload")) {
        return response({
          status: 200,
          data: {
            value: {
              video: "urn:li:video:x",
              uploadToken: "tok",
              thumbnailUploadUrl: "https://upload.linkedin.test/thumb",
              uploadInstructions: [
                { firstByte: 0, lastByte: 3, uploadUrl: "https://upload.linkedin.test/part-1" },
              ],
            },
          },
        });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  await assert.rejects(
    publishLinkedInNativePost(
      {
        connectedAccountId: "ca_linkedin_1",
        author: "urn:li:person:1",
        commentary: "A clip.",
        media: { ...VIDEO, thumbnailUrl: "https://cdn.test/missing-thumb.jpg" },
      },
      { fetcher, assertPublicUrl: async (url) => url },
    ),
    LinkedInMediaError,
  );

  assert.ok(
    !calls.includes("https://upload.linkedin.test/part-1"),
    "the video was orphaned on LinkedIn for a reason knowable before a byte went up",
  );
});
