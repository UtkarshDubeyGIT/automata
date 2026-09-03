import { strict as assert } from "node:assert";
import { test } from "node:test";
import { publishLinkedInNativePost } from "@/lib/social/linkedin-media";

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

test("an image is uploaded first and the post references its LinkedIn URN", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://cdn.test/product.png") {
      return response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "3" },
      });
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/images?action=initializeUpload")) {
        assert.equal(request.connected_account_id, "ca_linkedin_1");
        return response({
          status: 200,
          data: { value: { uploadUrl: "https://upload.linkedin.test/image", image: "urn:li:image:abc" } },
        });
      }
      if (request.endpoint === "https://upload.linkedin.test/image") {
        assert.equal(request.binary_body.content_type, "image/png");
        return response({ status: 201, data: {} });
      }
      if (request.endpoint.endsWith("/posts")) {
        return response({ status: 201, data: {}, headers: { "x-restli-id": "urn:li:share:42" } });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const result = await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:person:1",
      commentary: "A real product update.",
      media: { kind: "image", url: "https://cdn.test/product.png", altText: "Product dashboard" },
    },
    { fetcher, assertPublicUrl: async (url) => url },
  );

  assert.equal(result.id, "urn:li:share:42");
  const post = calls.find((call) => {
    if (!call.url.endsWith("/api/v3.1/tools/execute/proxy")) return false;
    return JSON.parse(String(call.init?.body)).endpoint.endsWith("/posts");
  });
  const payload = JSON.parse(String(post?.init?.body)).body;
  assert.deepEqual(payload.content, {
    media: { id: "urn:li:image:abc", altText: "Product dashboard" },
  });
  assert.equal(payload.commentary, "A real product update.");
});

test("multiple images are uploaded and published as one native multi-image post", async () => {
  const uploaded: string[] = [];
  let postBody: Record<string, unknown> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://cdn.test/")) {
      return response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/png", "content-length": "3" },
      });
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/images?action=initializeUpload")) {
        const index = uploaded.length + 1;
        return response({
          status: 200,
          data: {
            value: {
              uploadUrl: `https://upload.linkedin.test/image-${index}`,
              image: `urn:li:image:${index}`,
            },
          },
        });
      }
      if (request.endpoint.startsWith("https://upload.linkedin.test/image-")) {
        uploaded.push(request.binary_body.url);
        return response({ status: 201, data: {} });
      }
      if (request.endpoint.endsWith("/posts")) {
        postBody = request.body;
        return response({ status: 201, data: {}, headers: { "x-restli-id": "urn:li:share:multi" } });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const result = await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:person:1",
      commentary: "A few views from the launch.",
      media: [
        { kind: "image", url: "https://cdn.test/context.png", altText: "Team using the product" },
        { kind: "image", url: "https://cdn.test/demo.png", altText: "Product demo screen" },
      ],
    },
    { fetcher, assertPublicUrl: async (url) => url },
  );

  assert.equal(result.id, "urn:li:share:multi");
  assert.deepEqual(uploaded, [
    "https://cdn.test/context.png",
    "https://cdn.test/demo.png",
  ]);
  assert.deepEqual(postBody?.content, {
    multiImage: {
      images: [
        { id: "urn:li:image:1", altText: "Team using the product" },
        { id: "urn:li:image:2", altText: "Product demo screen" },
      ],
    },
  });
});

test("multi-image publishing refuses mixed media before downloading anything", async () => {
  let fetched = false;
  await assert.rejects(
    publishLinkedInNativePost(
      {
        connectedAccountId: "ca_linkedin_1",
        author: "urn:li:person:1",
        commentary: "Post",
        media: [
          { kind: "image", url: "https://cdn.test/context.png" },
          { kind: "video", url: "https://cdn.test/demo.mp4" },
        ],
      },
      { fetcher: async () => { fetched = true; return response(null); } },
    ),
    /only images/i,
  );
  assert.equal(fetched, false);
});

test("a PDF is uploaded as a document carousel with a human title", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://cdn.test/story.pdf") {
      return response(new Uint8Array([37, 80, 68, 70]), {
        headers: { "content-type": "application/pdf", "content-length": "4" },
      });
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/documents?action=initializeUpload")) {
        return response({
          status: 200,
          data: { value: { uploadUrl: "https://upload.linkedin.test/doc", document: "urn:li:document:abc" } },
        });
      }
      if (request.endpoint === "https://upload.linkedin.test/doc") return response({ status: 201, data: {} });
      if (request.endpoint.endsWith("/posts")) {
        return response({ status: 201, data: {}, headers: { "x-restli-id": "urn:li:share:43" } });
      }
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:organization:2",
      commentary: "Five lessons from the redesign.",
      media: { kind: "document", url: "https://cdn.test/story.pdf", title: "What we learned" },
    },
    { fetcher, assertPublicUrl: async (url) => url },
  );

  const post = calls.find((call) => {
    if (!call.url.endsWith("/api/v3.1/tools/execute/proxy")) return false;
    return JSON.parse(String(call.init?.body)).endpoint.endsWith("/posts");
  });
  const payload = JSON.parse(String(post?.init?.body)).body;
  assert.deepEqual(payload.content, {
    media: { id: "urn:li:document:abc", title: "What we learned" },
  });
});

test("a video is uploaded in LinkedIn's requested parts, finalized, and then posted", async () => {
  const video = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
  const uploadedParts: number[][] = [];
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === "https://cdn.test/demo.mp4") {
      return response(video, {
        headers: { "content-type": "video/mp4", "content-length": String(video.length) },
      });
    }
    if (url === "https://cdn.test/thumb.jpg") {
      return response(new Uint8Array([9, 8, 7]), {
        headers: { "content-type": "image/jpeg", "content-length": "3" },
      });
    }
    if (url.endsWith("/api/v3.1/tools/execute/proxy")) {
      const request = JSON.parse(String(init?.body));
      if (request.endpoint.endsWith("/videos?action=initializeUpload")) return response({
        status: 200,
        data: { value: {
          video: "urn:li:video:abc",
          uploadToken: "upload-token",
          thumbnailUploadUrl: "https://upload.linkedin.test/thumb",
          uploadInstructions: [
            { firstByte: 0, lastByte: 3, uploadUrl: "https://upload.linkedin.test/part-1" },
            { firstByte: 4, lastByte: 7, uploadUrl: "https://upload.linkedin.test/part-2" },
          ],
        } },
      });
      if (request.endpoint.endsWith("/videos?action=finalizeUpload")) return response({ status: 200, data: { value: {} } });
      if (request.endpoint.includes("/videos/urn%3Ali%3Avideo%3Aabc")) {
        return response({ status: 200, data: { status: "AVAILABLE" } });
      }
      if (request.endpoint.endsWith("/posts")) {
        return response({ status: 201, data: {}, headers: { "x-restli-id": "urn:li:share:44" } });
      }
    }
    if (url.includes("/part-")) {
      uploadedParts.push([...new Uint8Array(init?.body as ArrayBufferView as Uint8Array)]);
      return response(null, { status: 201, headers: { etag: `etag-${uploadedParts.length}` } });
    }
    if (url === "https://upload.linkedin.test/thumb") return response(null, { status: 201 });
    throw new Error(`Unexpected fetch ${url}`);
  };

  await publishLinkedInNativePost(
    {
      connectedAccountId: "ca_linkedin_1",
      author: "urn:li:organization:2",
      commentary: "A quick product tour.",
      media: {
        kind: "video",
        url: "https://cdn.test/demo.mp4",
        title: "Meet the new workflow builder",
        thumbnailUrl: "https://cdn.test/thumb.jpg",
      },
    },
    { fetcher, assertPublicUrl: async (url) => url, wait: async () => {} },
  );

  assert.deepEqual(uploadedParts, [
    [0, 1, 2, 3],
    [4, 5, 6, 7],
  ]);
  const finalize = calls.find((call) => {
    if (!call.url.endsWith("/api/v3.1/tools/execute/proxy")) return false;
    return JSON.parse(String(call.init?.body)).endpoint.endsWith("/videos?action=finalizeUpload");
  });
  assert.deepEqual(JSON.parse(String(finalize?.init?.body)).body.finalizeUploadRequest.uploadedPartIds, [
    "etag-1",
    "etag-2",
  ]);
  const post = calls.find((call) => {
    if (!call.url.endsWith("/api/v3.1/tools/execute/proxy")) return false;
    return JSON.parse(String(call.init?.body)).endpoint.endsWith("/posts");
  });
  assert.deepEqual(JSON.parse(String(post?.init?.body)).body.content, {
    media: { id: "urn:li:video:abc", title: "Meet the new workflow builder" },
  });
});

test("a remote asset redirect is re-validated before the server follows it", async () => {
  const checked: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://cdn.test/product.png") {
      return response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }
    throw new Error(`The private redirect must never be fetched: ${url}`);
  };

  await assert.rejects(
    publishLinkedInNativePost(
      {
        connectedAccountId: "ca_linkedin_1",
        author: "urn:li:person:1",
        commentary: "Post",
        media: { kind: "image", url: "https://cdn.test/product.png" },
      },
      {
        fetcher,
        assertPublicUrl: async (url) => {
          checked.push(url);
          return url.includes("169.254.169.254") ? null : url;
        },
      },
    ),
    /public URL/i,
  );
  assert.deepEqual(checked, [
    "https://cdn.test/product.png",
    "http://169.254.169.254/latest/meta-data",
  ]);
});

test("unsupported LinkedIn asset formats fail before an upload slot is created", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://cdn.test/product.webp") {
      return response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "image/webp", "content-length": "3" },
      });
    }
    throw new Error(`No LinkedIn upload should start for unsupported media: ${url}`);
  };

  await assert.rejects(
    publishLinkedInNativePost(
      {
        connectedAccountId: "ca_linkedin_1",
        author: "urn:li:person:1",
        commentary: "Post",
        media: { kind: "image", url: "https://cdn.test/product.webp" },
      },
      { fetcher, assertPublicUrl: async (url) => url },
    ),
    /JPG, GIF, or PNG/i,
  );
});
