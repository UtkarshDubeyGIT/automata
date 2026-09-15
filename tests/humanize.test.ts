import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_BANNED_WORDS,
  humanStyleRules,
  sanitizeHumanJson,
  sanitizeHumanParts,
  sanitizeHumanText,
} from "@/lib/ai/humanize";

/**
 * The guard rails that must hold whatever the model returns.
 *
 * Splitting the assertions the way the module splits: the dash and emoji rules
 * are promises this code keeps on its own, so they are tested against output.
 * Rhythm, vocabulary, openers and CTAs are only ever instructions, so the most
 * that can be asserted is that the instruction actually reaches the prompt.
 */

const EM = "—";
const EN = "–";

test("an em dash between two clauses becomes a comma", () => {
  assert.equal(
    sanitizeHumanText(`It is not a meme ${EM} it is already shipping.`),
    "It is not a meme, it is already shipping.",
  );
});

test("a dash before a standalone clause becomes a full stop", () => {
  assert.equal(
    sanitizeHumanText(`We shipped ${EM} Monday came early.`),
    "We shipped. Monday came early.",
  );
});

test("a numeric range keeps its meaning instead of becoming a list", () => {
  // "2020, 2024" says something different from "2020-2024".
  assert.equal(
    sanitizeHumanText(`Revenue grew 2020${EN}2024 across every region.`),
    "Revenue grew 2020-2024 across every region.",
  );
});

test("a dash opening a line is a bullet, not punctuation", () => {
  assert.equal(sanitizeHumanText(`${EM} first\n${EM} second`), "- first\n- second");
});

test("a trailing dash is dropped rather than turned into a stray comma", () => {
  assert.equal(sanitizeHumanText(`Something to consider ${EM}`), "Something to consider");
});

test("a dash next to existing punctuation does not double up", () => {
  assert.equal(
    sanitizeHumanText(`The plan, ${EM} and this matters ${EM} was simple.`),
    "The plan, and this matters, was simple.",
  );
});

test("zero tolerance: no dash survives any of these", () => {
  const inputs = [
    `a ${EM} b`,
    `a${EM}b`,
    `a ${EN} b`,
    `a${EM}${EM}b`,
    `${EM}`,
    `Q3 ${EM} Q4 planning starts now.`,
    `日本語 ${EM} これは重要です。`,
    `Ship it ${EM}\nnext line`,
  ];
  for (const input of inputs) {
    const out = sanitizeHumanText(input);
    assert.doesNotMatch(out, /[–—]/, `a dash survived ${JSON.stringify(input)}`);
  }
});

test("a dash inside a URL is left alone, because a broken link is the worse bug", () => {
  const out = sanitizeHumanText(`Read https://example.com/a${EM}b for the rest.`);
  assert.equal(out, `Read https://example.com/a${EM}b for the rest.`);
});

test("a hyphenated compound is not a dash and is never touched", () => {
  assert.equal(
    sanitizeHumanText("state-of-the-art tooling, end-to-end."),
    "state-of-the-art tooling, end-to-end.",
  );
});

test("emoji are capped at two", () => {
  assert.equal(sanitizeHumanText("Nice 🙂 work 👋 today 🤝 team 🤞"), "Nice 🙂 work 👋 today team");
});

test("only face and hand emoji survive the whitelist", () => {
  assert.equal(sanitizeHumanText("Ship it 🔥🚀 today ✅"), "Ship it today");
  assert.equal(sanitizeHumanText("Nice work 🙂 and thanks 👋"), "Nice work 🙂 and thanks 👋");
});

test("keycaps and flags are stripped — Extended_Pictographic misses both", () => {
  // The obvious detector (\p{Extended_Pictographic}) matches neither of these,
  // so they would have sailed straight past the whitelist.
  assert.equal(sanitizeHumanText("Step 1️⃣ of three"), "Step of three");
  assert.equal(sanitizeHumanText("Shipping to 🇮🇳 next"), "Shipping to next");
});

test("a ZWJ sequence is judged whole, not by its first codepoint alone", () => {
  // 👨‍👩‍👧‍👦 is a people emoji, not a face or a hand.
  assert.equal(sanitizeHumanText("Our team 👨‍👩‍👧‍👦 grew"), "Our team grew");
});

test("a skin-tone modifier stays attached to an allowed emoji", () => {
  assert.equal(sanitizeHumanText("Nice 👍🏽"), "Nice 👍🏽");
});

test("wrap-up filler is stripped and the sentence still reads", () => {
  assert.equal(
    sanitizeHumanText("We shipped. In conclusion, the plan worked."),
    "We shipped. The plan worked.",
  );
  assert.equal(sanitizeHumanText("At the end of the day, it shipped."), "It shipped.");
});

test("stacked filler is stripped in one call, so the result is stable", () => {
  assert.equal(
    sanitizeHumanText("In conclusion, to sum up, we shipped."),
    "We shipped.",
  );
});

test("sanitizing twice changes nothing the second time", () => {
  const inputs = [
    `It is not a meme ${EM} it is already shipping. 🔥🙂👋🤝`,
    "In conclusion, to sum up, we shipped 🚀🚀.",
    `Revenue 2020${EN}2024 ${EM} up.`,
    `${EM} bullet one\n${EM} bullet two`,
  ];
  for (const input of inputs) {
    const once = sanitizeHumanText(input);
    assert.equal(sanitizeHumanText(once), once, `not idempotent for ${JSON.stringify(input)}`);
  }
});

test("empty and untouched copy pass through unchanged", () => {
  assert.equal(sanitizeHumanText(""), "");
  const clean = "Solo founders are not lonely anymore.\n\nThey have agents. What would you automate?";
  assert.equal(sanitizeHumanText(clean), clean);
});

test("the rules the model must follow are all actually in the prompt block", () => {
  const rules = humanStyleRules();
  for (const word of HUMAN_BANNED_WORDS) {
    assert.match(rules, new RegExp(word.replace("-", "\\-")), `"${word}" never reached the prompt`);
  }
  assert.match(rules, /No two consecutive sentences may be\nthe same length/);
  assert.match(rules, /never use an em dash/i);
  assert.match(rules, /at most two/i);
  assert.match(rules, /In today's fast-paced/);
  assert.match(rules, /In conclusion/);
  assert.match(rules, /not only \.\.\. but also/);
  assert.match(rules, /tag a friend/);
});

test("the closing-question rule is opt-in, because a Slack alert must not ask one", () => {
  assert.doesNotMatch(humanStyleRules(), /End on a real question/);
  assert.match(humanStyleRules({ closeOnQuestion: true }), /End on a real question/);
});

test("the pieces of one post share a single emoji budget", () => {
  // A ten-slide carousel is one post. Sanitizing each field on its own would
  // have given every heading and body two emoji of its own.
  const slides = ["Hook 🙂", "Two 👋", "Three 🤝", "Four 🤞"];
  assert.deepEqual(sanitizeHumanParts(slides), ["Hook 🙂", "Two 👋", "Three", "Four"]);
});

test("each variation is its own post and gets its own budget", () => {
  assert.equal(sanitizeHumanText("One 🙂👋"), "One 🙂👋");
  assert.equal(sanitizeHumanText("Two 🙂👋"), "Two 🙂👋");
});

test("a blank line between paragraphs survives a dash at the end of one", () => {
  // `\s*` around the dash was the first implementation and it ate the blank
  // line, collapsing two paragraphs into one — in the one place a model
  // reliably puts a dash, and against every channel brief that asks for short
  // paragraphs separated by blank lines.
  assert.equal(
    sanitizeHumanText(`We shipped it${EM}\n\nAnd it worked.`),
    "We shipped it\n\nAnd it worked.",
  );
  assert.equal(
    sanitizeHumanText(`The hook${EM}\n\nThe body${EM}\n\nThe close.`),
    "The hook\n\nThe body\n\nThe close.",
  );
});

test("the whole dash family is covered, not just em and en", () => {
  // A model told "no em dashes" reaches for the next dash along, or for "--".
  assert.equal(sanitizeHumanText("Ship it ― now"), "Ship it, now");
  assert.equal(sanitizeHumanText("Ship it ‒ now"), "Ship it, now");
  assert.equal(sanitizeHumanText("a -- b"), "a, b");
  assert.equal(sanitizeHumanText("a --- b"), "a, b");
});

test("a minus sign is arithmetic, not punctuation, and is left alone", () => {
  assert.equal(sanitizeHumanText("Temp − 5 degrees"), "Temp − 5 degrees");
  assert.equal(sanitizeHumanText("Run it with --watch enabled"), "Run it with --watch enabled");
});

test("the trademark, copyright and registered signs are never deleted", () => {
  // Extended_Pictographic matches all three. Silently removing a trademark
  // symbol from brand copy is an edit nobody asked for.
  assert.equal(sanitizeHumanText("Acme™ and Beta®, © 2026"), "Acme™ and Beta®, © 2026");
});

test("the newer face and hand blocks are not stripped as unknown", () => {
  assert.equal(sanitizeHumanText("Nice \u{1FAE1} and \u{1FAF6}"), "Nice \u{1FAE1} and \u{1FAF6}");
});

test("the prompt-only rules are genuinely not enforced in code", () => {
  // Deliberate. Removing a banned word needs the sentence rewritten, and a
  // brand really in landscaping is allowed to say "landscape". A future
  // contributor adding regex word-stripping here should fail this test.
  const s = "Let's delve into this vibrant landscape. In today's fast-paced world, tag a friend.";
  assert.equal(sanitizeHumanText(s), s);
});

test("json prose is cleaned but ids, enums and URLs are left alone", () => {
  const out = sanitizeHumanJson({
    text: `We shipped it${EM}it works 🔥🚀`,
    status: "positive",
    slug: "daily-linkedin-post",
    url: "https://example.com/a-b",
    count: 3,
    ok: true,
    nested: { body: `Two${EM}three` },
    items: [`Four${EM}five`, "single_token"],
  });
  assert.deepEqual(out, {
    text: "We shipped it, it works",
    status: "positive",
    slug: "daily-linkedin-post",
    url: "https://example.com/a-b",
    count: 3,
    ok: true,
    nested: { body: "Two, three" },
    items: ["Four, five", "single_token"],
  });
});

test("one json result is one message, so its prose shares one emoji budget", () => {
  assert.deepEqual(
    sanitizeHumanJson({ subject: "Hi 🙂", body: "There 👋", ps: "Bye 🤝" }),
    { subject: "Hi 🙂", body: "There 👋", ps: "Bye" },
  );
});

test("sanitizing never throws, whatever it is handed", () => {
  for (const input of ["", " ", EM.repeat(50), "🔥".repeat(50), "\ud800", "a".repeat(200_000)]) {
    assert.doesNotThrow(() => sanitizeHumanText(input));
  }
  assert.doesNotThrow(() => sanitizeHumanJson(null));
  assert.doesNotThrow(() => sanitizeHumanParts([]));
});
