import assert from "node:assert/strict";
import test from "node:test";

import { brandContext, type BrandProfile } from "@/lib/brand";

const base: BrandProfile = { company: "Acme", tone: "Candid — direct and honest." };

test("a solo workspace tells the model to write as one person", () => {
  const context = brandContext({ ...base, audienceMode: "solo" });

  assert.match(context, /Voice Person: write as one person/);
});

test("a workspace with a team tells the model to write as a company", () => {
  const context = brandContext({ ...base, audienceMode: "team" });

  assert.match(context, /Voice Person: write as a company/);
});

test("an unanswered solo-or-team question adds no line at all", () => {
  // This reaches aiStep, socialPost, generateImage and generateVideo alike, so
  // an unset value has to stay silent rather than defaulting to one of them.
  // Guessing "we" for a freelancer is exactly the wrong-voice failure the flow
  // exists to avoid.
  const context = brandContext(base);

  assert.doesNotMatch(context, /Voice Person/);
});

test("the persona is stored for segmentation but never reaches the prompt", () => {
  // A model told "the user is a Student" writes differently in ways nobody
  // specified. It is kept for template matching, not for grounding.
  const context = brandContext({ ...base, persona: "student" });

  assert.doesNotMatch(context, /student/i);
  assert.doesNotMatch(context, /Persona/);
});

test("an empty profile still produces no brand block", () => {
  assert.equal(brandContext({}), "");
  assert.equal(brandContext(null), "");
});
