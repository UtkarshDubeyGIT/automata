import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import type { WebsiteAnalysis } from "@/lib/brand";

let signedIn = true;
let stored: Record<string, unknown> = {};
let savedWorkspace: Record<string, unknown> | null = null;
let reachable = true;
let calls = 0;
let result: WebsiteAnalysis | null = null;
let hang = false;

const supabase = {
  from(table: string) {
    assert.equal(table, "workspaces");
    let updating = false;
    const query = {
      select: () => query,
      eq: () => query,
      update: (value: Record<string, unknown>) => {
        updating = true;
        savedWorkspace = value;
        return query;
      },
      maybeSingle: async () =>
        updating
          ? { data: { id: "workspace-1" }, error: null }
          : { data: { brand_profile: stored }, error: null },
    };
    return query;
  },
};

mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => ({
      supabase,
      userId: signedIn ? "user-1" : null,
      workspaceId: signedIn ? "workspace-1" : null,
    }),
  },
});
mock.module("@/lib/net/public-url", {
  namedExports: { assertPublicUrl: async (url: string) => (reachable ? url : null) },
});
mock.module("@/lib/ai/analyze", {
  namedExports: {
    analyzeWebsite: async () => {
      calls += 1;
      if (hang) throw new Error("firecrawl exploded");
      return result;
    },
  },
});

const { POST } = await import("@/app/api/onboarding/analyze/route");
const analyze = (website: unknown) =>
  POST(
    new Request("https://automata.example/api/onboarding/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website }),
    }),
  );

function reset(profile: Record<string, unknown> = {}) {
  signedIn = true;
  reachable = true;
  hang = false;
  calls = 0;
  stored = profile;
  savedWorkspace = null;
  result = { description: "Acme automates post-purchase email.", targetAudience: "D2C operators", voice: "plain" };
}

test("reading a site requires a signed-in workspace", async () => {
  reset();
  signedIn = false;

  assert.equal((await analyze("acme.com")).status, 401);
  assert.equal(calls, 0);
});

test("what the site says is filed under analysis, never over the user's own answers", async () => {
  reset();

  const res = await analyze("acme.com");

  assert.equal(res.status, 200);
  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  const analysis = profile.analysis as WebsiteAnalysis;
  assert.equal(analysis.description, "Acme automates post-purchase email.");
  assert.equal(analysis.targetAudience, "D2C operators");
  // Top-level is where a decision lives. Writing there would make the scrape
  // indistinguishable from something the user typed, and settings could no
  // longer honestly label it "from your website".
  assert.equal("description" in profile, false);
  assert.equal("tone" in profile, false);
  assert.equal("audience" in profile, false);
  assert.equal(profile.website, "https://acme.com");
});

test("an answer the user already gave survives the scrape landing later", async () => {
  reset({ description: "My own words", audience: "Founders" });

  await analyze("acme.com");

  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  assert.equal(profile.description, "My own words");
  assert.equal(profile.audience, "Founders");
});

test("a scrape that fails keeps the address and invents nothing", async () => {
  reset();
  hang = true;

  const res = await analyze("acme.com");
  const payload = (await res.json()) as { analysis: unknown };

  assert.equal(res.status, 200);
  assert.equal(payload.analysis, null);
  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  // The URL is the user's answer and is kept. Nothing is guessed from it.
  assert.equal(profile.website, "https://acme.com");
  assert.equal("analysis" in profile, false);
  assert.equal("description" in profile, false);
});

test("a site that resolves to a private address is refused before any fetch", async () => {
  reset();
  reachable = false;

  const res = await analyze("http://169.254.169.254/latest/meta-data");

  assert.equal(res.status, 400);
  assert.equal(calls, 0);
  assert.equal(savedWorkspace, null);
});

test("blurring the same field twice does not pay for a second scrape", async () => {
  reset({
    website: "https://acme.com",
    analysis: { description: "Already known." },
  });

  const res = await analyze("acme.com");
  const payload = (await res.json()) as { cached: boolean };

  assert.equal(payload.cached, true);
  assert.equal(calls, 0);
  assert.equal(savedWorkspace, null);
});

test("an unparseable address never reaches the scraper", async () => {
  reset();

  const res = await analyze("not a website");

  assert.equal(res.status, 400);
  assert.equal(calls, 0);
});
