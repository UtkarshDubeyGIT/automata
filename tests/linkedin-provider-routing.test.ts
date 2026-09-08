import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

process.env.COMPOSIO_API_KEY = "test-key";

let nativeInput: Record<string, unknown> | null = null;
let nativeFailure: Error | null = null;

mock.module("@/lib/social/linkedin-document", {
  namedExports: {
    linkedinConnectedAccountId: async () => "ca-linkedin",
  },
});

mock.module("@/lib/social/linkedin-media", {
  namedExports: {
    publishLinkedInNativePost: async (input: Record<string, unknown>) => {
      nativeInput = input;
      if (nativeFailure) throw nativeFailure;
      return { id: "urn:li:share:99" };
    },
  },
});

const { socialProvider } = await import("@/lib/social/composio");

test("a pending LinkedIn upload keeps its resume marker across the provider boundary", async () => {
  nativeFailure = Object.assign(new Error("Still processing"), {
    retry: "defer", resume: { linkedinVideoUrn: "urn:li:video:pending" },
  });
  try {
    const result = await socialProvider.post({
      entityId: "ws-1", platform: "linkedin", text: "Our product tour",
      media: { kind: "video", url: "https://cdn.test/tour.mp4" },
      options: { pageId: "123" },
    });
    assert.equal(result.ok, false);
    assert.equal(result.retry, "defer");
    assert.deepEqual(result.resume, { linkedinVideoUrn: "urn:li:video:pending" });
  } finally {
    nativeFailure = null;
  }
});

test("a resumed provider call passes the existing video URN to the native uploader", async () => {
  nativeInput = null;
  const result = await socialProvider.post({
    entityId: "ws-1", platform: "linkedin", text: "Our product tour",
    media: { kind: "video", url: "https://cdn.test/tour.mp4" },
    options: { pageId: "123", linkedinVideoUrn: "urn:li:video:pending" },
  });
  assert.equal(result.ok, true);
  assert.equal((nativeInput as Record<string, unknown> | null)?.resumeVideoUrn, "urn:li:video:pending");
});

test("LinkedIn media uses the native uploader for both company pages and subtle links", async () => {
  const result = await socialProvider.post({
    entityId: "ws-1",
    platform: "linkedin",
    text: "What we learned while rebuilding onboarding.",
    media: {
      kind: "image",
      url: "https://cdn.test/onboarding.png",
      altText: "The new onboarding screen",
    },
    link: {
      url: "https://zaneye.com/onboarding",
      style: "soft",
    },
    options: { pageId: "123" },
  });

  assert.deepEqual(result, { ok: true, externalId: "urn:li:share:99" });
  assert.deepEqual(nativeInput, {
    connectedAccountId: "ca-linkedin",
    author: "urn:li:organization:123",
    commentary:
      "What we learned while rebuilding onboarding.\n\nMore context: https://zaneye.com/onboarding",
    media: {
      kind: "image",
      url: "https://cdn.test/onboarding.png",
      altText: "The new onboarding screen",
    },
  });
});
