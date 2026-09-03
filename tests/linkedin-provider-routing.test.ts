import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

process.env.COMPOSIO_API_KEY = "test-key";

let nativeInput: Record<string, unknown> | null = null;

mock.module("@/lib/social/linkedin-document", {
  namedExports: {
    linkedinConnectedAccountId: async () => "ca-linkedin",
  },
});

mock.module("@/lib/social/linkedin-media", {
  namedExports: {
    publishLinkedInNativePost: async (input: Record<string, unknown>) => {
      nativeInput = input;
      return { id: "urn:li:share:99" };
    },
  },
});

const { socialProvider } = await import("@/lib/social/composio");

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
