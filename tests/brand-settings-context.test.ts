import { strict as assert } from "node:assert";
import { test } from "node:test";
import { brandContext, brandReadiness } from "@/lib/brand";

test("saved brand voice, language and audience reach the AI workflow context", () => {
  const profile = {
    company: "Acme",
    language: "Hindi",
    tone: "Educational",
    voiceGuidelines: "Use short sentences and concrete examples.",
    audience: "Agency founders",
    analysis: { description: "Approvals for teams" },
  };
  const context = brandContext(profile);
  for (const value of [profile.company, profile.language, profile.tone, profile.voiceGuidelines, profile.audience]) {
    assert.ok(context.includes(value), `AI context must include ${value}`);
  }
  assert.equal(brandReadiness(profile).audience, "Agency founders");
});

test("research and site voice remain available when explicit settings are absent", () => {
  const context = brandContext({
    analysis: { voice: "Plain-spoken", language: "Spanish" },
    research: { status: "ready", summary: "Scheduling software", capabilities: ["Timezone conversion"] },
  });
  assert.match(context, /Plain-spoken/);
  assert.match(context, /Spanish/);
  assert.match(context, /Scheduling software/);
  assert.match(context, /Timezone conversion/);
});
