import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/config/seo";

test("the sitemap exposes only the public, canonical pages", () => {
  const entries = sitemap();

  assert.deepEqual(
    entries.map((entry) => entry.url),
    [`${SITE_URL}/`, `${SITE_URL}/privacy`, `${SITE_URL}/terms`],
  );
  assert.equal(entries[0].priority, 1);
  assert.equal(entries[0].changeFrequency, "weekly");
});

test("robots welcomes crawlers to public pages and keeps private routes out", () => {
  const policy = robots();
  const rule = Array.isArray(policy.rules) ? policy.rules[0] : policy.rules;

  assert.equal(policy.sitemap, `${SITE_URL}/sitemap.xml`);
  assert.equal(rule.allow, "/");
  assert.deepEqual(rule.disallow, ["/app/", "/onboarding/", "/workflows/", "/integrations/", "/api/", "/auth/"]);
});

test("the homepage describes Automata to search and AI agents with structured data", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");

  assert.match(page, /application\/ld\+json/);
  assert.match(page, /SoftwareApplication/);
  assert.match(page, /FAQPage/);
  assert.match(page, /Automata is a visual automation workspace/);
});

test("root metadata sets a canonical identity and share preview", () => {
  const layout = readFileSync("src/app/layout.tsx", "utf8");

  assert.match(layout, /metadataBase/);
  assert.match(layout, /alternates:\s*\{\s*canonical:/);
  assert.match(layout, /openGraph:/);
  assert.match(layout, /twitter:/);
});

test("legal pages use valid, directly readable home navigation", () => {
  for (const path of ["src/app/privacy/page.tsx", "src/app/terms/page.tsx"]) {
    const page = readFileSync(path, "utf8");
    assert.doesNotMatch(page, /<Link href="\/">\s*<Logo \/>\s*<\/Link>/);
  }
});
