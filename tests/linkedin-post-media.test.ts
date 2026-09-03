import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  captionWithWebsiteLink,
  inferPostMediaKind,
  normalizePostMedia,
  normalizePostMediaList,
  normalizeStoredPostExtras,
} from "@/lib/social/post-media";

test("a website link is optional and soft promotion stays understated", () => {
  const caption = captionWithWebsiteLink("A small lesson from this week's launch.", {
    url: "https://zaneye.com/launch-notes",
    style: "soft",
  });

  assert.equal(
    caption,
    "A small lesson from this week's launch.\n\nMore context: https://zaneye.com/launch-notes",
  );
  assert.doesNotMatch(caption, /buy now|book a demo|limited time/i);
  assert.equal(
    captionWithWebsiteLink("A useful post.", {
      url: "https://zaneye.com",
      style: "none",
    }),
    "A useful post.",
  );
});

test("a newline-separated image gallery normalizes to two through twenty images", () => {
  assert.deepEqual(
    normalizePostMediaList(
      "https://cdn.test/context.png\n\nhttps://cdn.test/demo.png\nhttps://cdn.test/logo.png",
    ),
    [
      { kind: "image", url: "https://cdn.test/context.png" },
      { kind: "image", url: "https://cdn.test/demo.png" },
      { kind: "image", url: "https://cdn.test/logo.png" },
    ],
  );
  assert.throws(() => normalizePostMediaList("https://cdn.test/only.png"), /at least 2/i);
  assert.throws(
    () => normalizePostMediaList(Array.from({ length: 21 }, (_, index) => `https://cdn.test/${index}.png`).join("\n")),
    /at most 20/i,
  );
});

test("an existing website link is not appended twice", () => {
  const caption = "The full walkthrough is at https://zaneye.com/guide";
  assert.equal(
    captionWithWebsiteLink(caption, {
      url: "https://zaneye.com/guide/",
      style: "soft",
    }),
    caption,
  );
});

test("a custom link label can sound like the person instead of a template", () => {
  assert.equal(
    captionWithWebsiteLink("Here is what changed.", {
      url: "https://zaneye.com/changelog",
      style: "soft",
      label: "I wrote up the details",
    }),
    "Here is what changed.\n\nI wrote up the details: https://zaneye.com/changelog",
  );
});

test("LinkedIn captions stay within the 3,000 character limit after adding a link", () => {
  const caption = captionWithWebsiteLink("x".repeat(3_000), {
    url: "https://zaneye.com/read-more",
    style: "soft",
  });
  assert.ok(caption.length <= 3_000);
  assert.match(caption, /https:\/\/zaneye\.com\/read-more$/);
});

test("media type can be explicit or inferred from a clean URL path", () => {
  assert.equal(inferPostMediaKind("https://cdn.test/product.PNG?token=1"), "image");
  assert.equal(inferPostMediaKind("https://cdn.test/demo.mp4"), "video");
  assert.equal(inferPostMediaKind("https://cdn.test/deck.pdf"), "document");
  assert.equal(inferPostMediaKind("https://cdn.test/asset"), null);

  assert.deepEqual(
    normalizePostMedia({
      url: "https://cdn.test/asset",
      kind: "video",
      title: "A 30-second product tour",
      thumbnailUrl: "https://cdn.test/thumb.jpg",
    }),
    {
      url: "https://cdn.test/asset",
      kind: "video",
      title: "A 30-second product tour",
      thumbnailUrl: "https://cdn.test/thumb.jpg",
    },
  );
});

test("a media URL with no recognizable or explicit type is rejected before publishing", () => {
  assert.throws(
    () => normalizePostMedia({ url: "https://cdn.test/asset" }),
    /Choose whether the media is an image, video, or document/i,
  );
});

test("scheduled JSON metadata is recovered without trusting malformed rows", () => {
  assert.deepEqual(
    normalizeStoredPostExtras({
      media: { kind: "document", url: "https://cdn.test/deck.pdf", title: "The story" },
      link: { url: "https://zaneye.com/story", style: "soft", label: "The longer version" },
      options: { pageId: "123" },
    }),
    {
      media: { kind: "document", url: "https://cdn.test/deck.pdf", title: "The story" },
      link: { url: "https://zaneye.com/story", style: "soft", label: "The longer version" },
      options: { pageId: "123" },
    },
  );

  assert.deepEqual(
    normalizeStoredPostExtras({
      media: { kind: "audio", url: "https://cdn.test/file" },
      link: ["not", "an", "object"],
      options: "page=123",
    }),
    {},
  );
});
