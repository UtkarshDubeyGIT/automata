import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

let posted: Record<string, unknown> | null = null;

mock.module("@/lib/social/composio", {
  namedExports: {
    socialProvider: {
      live: true,
      post: async (input: Record<string, unknown>) => {
        posted = input;
        return { ok: true, externalId: "post-1" };
      },
    },
    executeTool: async () => ({ successful: true, data: {} }),
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => null,
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");
const { nodeSpec } = await import("@/lib/workflows/blocks");
const { setupGaps } = await import("@/lib/workflows/validate");
const { buildApprovalPreview } = await import("@/lib/workflows/preview");

test("the workflow editor exposes native LinkedIn media and subtle link controls", () => {
  const keys = nodeSpec("social_post")!.fields.map((field) => field.key);
  for (const key of [
    "mediaKind",
    "mediaUrl",
    "mediaUrls",
    "mediaTitle",
    "altText",
    "thumbnailUrl",
    "websiteUrl",
    "linkStyle",
    "linkLabel",
  ]) {
    assert.ok(keys.includes(key), `${key} should be editable`);
  }
});

test("a LinkedIn workflow carries multiple image URLs to one post", async () => {
  posted = null;
  await HANDLERS.social_post({
    runId: "run-multi",
    stepId: "publish",
    step: {
      type: "social_post",
      platform: "linkedin",
      text: "A few views from the launch.",
      mediaKind: "image",
      mediaUrls: "{{steps.context.url}}\n{{steps.demo.url}}\n{{steps.logo.url}}",
    },
    data: {
      steps: {
        context: { url: "https://cdn.test/context.png" },
        demo: { url: "https://cdn.test/demo.png" },
        logo: { url: "https://cdn.test/logo.png" },
      },
    },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.deepEqual((posted as unknown as { media?: unknown })?.media, [
    { kind: "image", url: "https://cdn.test/context.png" },
    { kind: "image", url: "https://cdn.test/demo.png" },
    { kind: "image", url: "https://cdn.test/logo.png" },
  ]);
});

test("choosing a LinkedIn media type without an asset URL is a setup gap", () => {
  const graph = {
    start: "go",
    steps: {
      go: { type: "manual_trigger_input", next: "post" },
      post: {
        type: "social_post",
        platform: "linkedin",
        text: "Post",
        mediaKind: "document",
        next: null,
      },
    },
  } as never;
  assert.deepEqual(setupGaps(graph), {
    post: ["Add the image, video, or PDF URL to publish"],
  });
});

test("a LinkedIn workflow carries video metadata, page choice, and website treatment to publishing", async () => {
  posted = null;
  await HANDLERS.social_post({
    runId: "run-1",
    stepId: "publish",
    step: {
      type: "social_post",
      platform: "linkedin",
      text: "A product tour.",
      mediaKind: "video",
      mediaUrl: "{{steps.film.url}}",
      mediaTitle: "The workflow in 30 seconds",
      thumbnailUrl: "https://cdn.test/thumb.jpg",
      websiteUrl: "https://zaneye.com/workflows",
      linkStyle: "soft",
      linkLabel: "I wrote up the details",
      options: { pageId: "123" },
    },
    data: { steps: { film: { url: "https://cdn.test/video-without-extension" } } },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);

  assert.deepEqual(posted, {
    entityId: "ws-1",
    platform: "linkedin",
    text: "A product tour.",
    mediaUrl: "https://cdn.test/video-without-extension",
    media: {
      kind: "video",
      url: "https://cdn.test/video-without-extension",
      title: "The workflow in 30 seconds",
      thumbnailUrl: "https://cdn.test/thumb.jpg",
    },
    link: {
      url: "https://zaneye.com/workflows",
      style: "soft",
      label: "I wrote up the details",
    },
    options: { pageId: "123" },
  });
});

test("approval preview recognizes an explicitly typed video and shows the website", () => {
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "post", on_reject: null },
      post: {
        type: "social_post",
        platform: "linkedin",
        text: "A product tour.",
        mediaKind: "video",
        mediaUrl: "https://cdn.test/asset",
        websiteUrl: "https://zaneye.com/workflows",
        linkStyle: "soft",
        next: null,
      },
    },
  } as never;
  const preview = buildApprovalPreview(graph, "review", {
    v: 1,
    journal: [],
    context: { steps: {} },
  });
  const action = preview!.actions[0];
  assert.equal(action.videoUrl, "https://cdn.test/asset");
  assert.equal(action.imageUrl, undefined);
  assert.deepEqual(action.fields, [
    { label: "Website", value: "https://zaneye.com/workflows" },
    { label: "Link treatment", value: "soft" },
  ]);
});
