import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * Content Studio's generators, and the copy they fall back to.
 *
 * The sample variations and the sample carousel ship whenever there is no
 * OPENAI_API_KEY, so they are the house's own writing and have to pass the
 * house's own rules. They did not: `sampleCarousel`'s last slide read "Reply
 * below — I read every one", an em dash and the closest thing in the repo to a
 * canned CTA, and `mockReply` carried the same em dash in a sentence
 * `sampleVariations` already wrote with a full stop. Pinned here so neither can
 * drift back.
 */

let calls: { role: string; content: string }[][] = [];

mock.module("@/lib/ai/openai", {
  namedExports: {
    chatJSON: async (messages: { role: string; content: string }[]) => {
      calls.push(messages);
      throw new Error("no key configured");
    },
  },
});

const { generateVariations, generateCarousel } = await import("@/lib/ai/content");
const { sanitizeHumanText } = await import("@/lib/ai/humanize");

test("the sample variations shipped without an API key already obey the rules", async () => {
  calls = [];
  const variations = await generateVariations({
    topic: "",
    format: "linkedin",
    tone: "founder",
    virality: 80,
    count: 3,
  });
  assert.equal(variations.length, 3);
  for (const v of variations) {
    assert.equal(v.text, sanitizeHumanText(v.text), `sample copy needs cleaning: ${v.text}`);
  }
});

test("the sample carousel obeys them too, slides and rendered text alike", async () => {
  calls = [];
  const [carousel] = await generateCarousel({ topic: "", tone: "founder", virality: 80 });
  assert.ok(carousel.slides.length >= 3);
  for (const slide of carousel.slides) {
    assert.equal(slide.heading, sanitizeHumanText(slide.heading));
    assert.equal(slide.body, sanitizeHumanText(slide.body));
  }
  // The rendered form is deliberately NOT run through the sanitizer — slides are
  // cleaned first precisely so the "1 / 6  " numbering, double space and all,
  // never reaches it. So assert the invariant that matters instead.
  assert.doesNotMatch(carousel.text, /[\u2012\u2013\u2014\u2015]/);
});

test("the house style reaches the Content Studio prompt", async () => {
  calls = [];
  await generateVariations({ topic: "growth", format: "linkedin", tone: "founder", virality: 80 });
  const system = calls[0]?.find((m) => m.role === "system")?.content ?? "";
  assert.match(system, /HOW TO WRITE/);
  assert.match(system, /never use an em dash/i);
  assert.match(system, /End on a real question/);
});

test("a format that is a fragment is not told to end on a question", async () => {
  // A `cta` is one line meant to be placed inside something else, and a `hook`
  // is three openers. Ending either on a question is incoherent.
  calls = [];
  await generateVariations({ topic: "growth", format: "cta", tone: "founder", virality: 80 });
  const system = calls[0]?.find((m) => m.role === "system")?.content ?? "";
  assert.match(system, /HOW TO WRITE/);
  assert.doesNotMatch(system, /End on a real question/);
});
