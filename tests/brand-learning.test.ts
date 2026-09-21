import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildVoiceCandidate,
  sanitizeVoiceSamples,
  type VoiceSample,
} from "@/lib/brand-learning";
import { brandContext, type BrandProfile } from "@/lib/brand";

const samples: VoiceSample[] = [
  {
    sourceType: "slack",
    sourceId: "channel-general",
    authorId: "author-1",
    createdAt: "2026-09-20T12:00:00.000Z",
    text: "Ship the smallest useful version first.\n\n--\nAlex\n> quoted reply",
  },
  {
    sourceType: "gmail",
    sourceId: "message-1",
    authorId: "sender-1",
    createdAt: "2026-09-19T12:00:00.000Z",
    text: "Thanks for the context. Let's make the next step concrete.",
  },
];

test("voice sampling strips quoted/signature text and caps the selected window", () => {
  const sanitized = sanitizeVoiceSamples(samples, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(sanitized.length, 2);
  assert.equal(sanitized[0].text, "Ship the smallest useful version first.");
  assert.equal("text" in sanitized[0].provenance, false);
  assert.equal(sanitizeVoiceSamples([{ ...samples[0], createdAt: "2025-01-01T00:00:00.000Z" }], new Date("2026-09-21T00:00:00.000Z")).length, 0);
});

test("voice candidate stores guidance and provenance but no raw sample bodies", () => {
  const candidate = buildVoiceCandidate(sanitizeVoiceSamples(samples, new Date("2026-09-21T00:00:00.000Z")), {
    website: "https://example.com",
    now: new Date("2026-09-21T00:00:00.000Z"),
  });
  assert.match(candidate.guidance, /specific|sentence|direct/i);
  assert.equal(candidate.sourceRefs.length, 2);
  assert.equal(JSON.stringify(candidate.sourceRefs).includes("Ship the smallest"), false);
  assert.ok(candidate.confidence > 0);
});

test("website-derived research is provenance-labeled rather than stored as a raw sample", () => {
  const candidate = buildVoiceCandidate([], {
    website: "https://example.com",
    websiteGuidance: "Plain, direct product language",
    now: new Date("2026-09-21T00:00:00.000Z"),
  });
  assert.match(candidate.guidance, /website research/i);
  assert.deepEqual(candidate.sourceRefs, [
    {
      sourceType: "website",
      sourceId: "https://example.com",
      authorId: "website-analysis",
      observedAt: "2026-09-21T00:00:00.000Z",
    },
  ]);
});

test("explicit brand guidance outranks learned voice, which outranks website voice", () => {
  const learned: BrandProfile = {
    analysis: { voice: "Website voice" },
    learnedVoice: { guidance: "Learned direct voice", status: "accepted", version: 1 },
  };
  assert.match(brandContext(learned), /Learned direct voice/);
  const explicit: BrandProfile = {
    ...learned,
    tone: "Explicit tone",
    voiceGuidelines: "Explicit rules",
  };
  const context = brandContext(explicit);
  assert.match(context, /Brand Voice: Explicit tone/);
  assert.match(context, /Voice Guidelines: Explicit rules/);
  assert.equal(context.includes("Learned direct voice"), false);
});
