import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { SITE_URL } from "@/config/seo";
import { publicPageMetadata } from "@/lib/seo-metadata";

test("the sitemap exposes only the public, canonical pages", () => {
  const entries = sitemap();

  assert.deepEqual(
    entries.map((entry) => entry.url),
    [SITE_URL, `${SITE_URL}/privacy`, `${SITE_URL}/terms`],
  );
  assert.equal(entries[0].priority, 1);
  assert.equal(entries[0].changeFrequency, "weekly");
});

test("robots lets crawlers see route-level noindex while excluding machine endpoints", () => {
  const policy = robots();
  const rule = Array.isArray(policy.rules) ? policy.rules[0] : policy.rules;

  assert.equal(policy.sitemap, `${SITE_URL}/sitemap.xml`);
  assert.equal(rule.allow, "/");
  assert.deepEqual(rule.disallow, ["/api/", "/auth/", "/hooks/"]);
});

test("the homepage describes Automata to search and AI agents with structured data", () => {
  const page = readFileSync("src/app/page.tsx", "utf8");
  const landing = readFileSync("src/components/landing-space/space-landing.tsx", "utf8");

  assert.match(page, /application\/ld\+json/);
  assert.match(page, /SoftwareApplication/);
  assert.match(page, /FAQPage/);
  assert.match(page, /mainEntity:\s*questions\.map/);
  assert.match(page, /title: `\$\{pageTitle\} \| \$\{BRAND\.name\}`/);
  assert.match(landing, /Automata is an AI workflow automation builder/);
  assert.match(landing, /export const questions/);
  assert.match(landing, /questions\.map\(\(item, index\)/);
  assert.match(page, /alternates:\s*\{\s*canonical:\s*"\/"\s*\}/);
  assert.match(page, /AI workflow automation for operators and developers/);
  assert.match(page, /openGraph:/);
  assert.match(page, /url: `\$\{SITE_URL\}\/`/);
  assert.match(page, /description: pageDescription/);
  assert.match(page, /twitter:/);
  assert.doesNotMatch(page, /pageTitle\("AI Workflow Automation Builder"\)/);
});

test("public page metadata has unique canonical, Open Graph, and social details", () => {
  const privacy = publicPageMetadata({ title: "Privacy Policy", description: "Privacy description", path: "/privacy" });
  const terms = publicPageMetadata({ title: "Terms of Service", description: "Terms description", path: "/terms" });

  assert.equal(privacy.alternates?.canonical, "/privacy");
  assert.equal(terms.alternates?.canonical, "/terms");
  assert.equal(privacy.openGraph?.url, `${SITE_URL}/privacy`);
  assert.equal(terms.openGraph?.url, `${SITE_URL}/terms`);
  assert.notEqual(privacy.description, terms.description);
  assert.ok(privacy.twitter);
  assert.ok(privacy.openGraph?.images);
  assert.ok(terms.twitter?.images);
});

test("legal pages use distinct summaries and preview pages are excluded from indexing", () => {
  for (const [path, canonical] of [["src/app/privacy/page.tsx", "/privacy"], ["src/app/terms/page.tsx", "/terms"]]) {
    const page = readFileSync(path, "utf8");
    assert.match(page, /publicPageMetadata/);
    assert.match(page, new RegExp(`path: "${canonical}"`));
    assert.match(page, /description:/);
    assert.doesNotMatch(page, /<Link href="\/">\s*<Logo \/>\s*<\/Link>/);
  }

  for (const path of ["src/app/prototype/landing-classic/page.tsx", "src/app/prototype/sky-theme/page.tsx"]) {
    const page = readFileSync(path, "utf8");
    assert.match(page, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false/);
  }
});

test("private interfaces carry noindex metadata and remain crawlable for that directive", () => {
  for (const path of ["src/app/app/layout.tsx", "src/app/onboarding/page.tsx", "src/app/(auth)/layout.tsx"]) {
    const page = readFileSync(path, "utf8");
    assert.match(page, /robots:\s*\{\s*index:\s*false,\s*follow:\s*false/);
  }

  const policy = robots();
  const rule = Array.isArray(policy.rules) ? policy.rules[0] : policy.rules;
  const disallowed = Array.isArray(rule.disallow) ? rule.disallow.join(" ") : rule.disallow ?? "";
  assert.doesNotMatch(disallowed, /\/(?:app|onboarding)\//);
});

test("agent guidance lists only canonical public pages", () => {
  const guidance = readFileSync("public/llms.txt", "utf8");

  assert.match(guidance, /^# Automata/m);
  assert.match(guidance, /AI workflow automation builder/);
  assert.match(guidance, new RegExp(`Home: ${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`));
  assert.match(guidance, new RegExp(`Privacy policy: ${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/privacy`));
  assert.match(guidance, new RegExp(`Terms of service: ${SITE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/terms`));
});

test("legal pages use valid, directly readable home navigation", () => {
  for (const path of ["src/app/privacy/page.tsx", "src/app/terms/page.tsx"]) {
    const page = readFileSync(path, "utf8");
    assert.doesNotMatch(page, /<Link href="\/">\s*<Logo \/>\s*<\/Link>/);
  }
});
