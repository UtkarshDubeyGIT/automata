import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let signedIn = true;
let writable = true;
let failure = false;
let legacySchema = false;
let savedTimezone = "UTC";
let saved: Record<string, unknown> | null = null;
let profile: Record<string, unknown> = {
  company: "Acme",
  language: "Hindi",
  analysis: { description: "Operations software", features: ["Approvals"], targetAudience: "Teams" },
  brandKit: { primaryColor: "#444444" },
  ads: { metaAdAccountId: "act_1" },
};
const scopes: Array<[string, unknown]> = [];
const supabase = {
  auth: { getUser: async () => ({ data: { user: { email: "owner@example.com" } } }) },
  from(table: string) {
    assert.ok(["workspaces", "agent_settings", "profiles"].includes(table));
    let updating = false;
    let columns = "";
    const query = {
      select: (value: string) => { columns = value; return query; },
      eq: (key: string, value: unknown) => { scopes.push([key, value]); return query; },
      update: (value: Record<string, unknown>) => {
        updating = true;
        if (table === "agent_settings") savedTimezone = value.timezone as string;
        else saved = value;
        return query;
      },
      maybeSingle: async () => table === "profiles"
        ? { data: { full_name: "Dev Dubey", avatar_url: "https://lh3.googleusercontent.com/a/photo" }, error: null }
        : table === "agent_settings"
        ? { data: { workspace_id: "workspace-1", timezone: savedTimezone }, error: null }
        : legacySchema && columns.includes("timezone") && !updating
        ? { data: null, error: { code: "42703", message: "column workspaces.timezone does not exist" } }
        : ({
        data: failure || (updating && !writable) ? null : updating
          ? { id: "workspace-1" }
          : { id: "workspace-1", name: "Acme", timezone: "Asia/Kolkata", brand_profile: profile },
        error: failure ? { message: "database offline" } : null,
      }),
    };
    return query;
  },
};
mock.module("@/lib/workspace", { namedExports: {
  resolveRequestContext: async () => ({ supabase, userId: signedIn ? "user-1" : null, workspaceId: signedIn ? "workspace-1" : null }),
} });

const { GET, PATCH } = await import("@/app/api/settings/route");
const { GET: readiness } = await import("@/app/api/brand/readiness/route");
const patch = (value: unknown) => PATCH(new Request("https://automata.example/api/settings", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
}));

test("settings and brand readiness require a signed-in workspace", async () => {
  signedIn = false;
  assert.equal((await GET()).status, 401);
  assert.equal((await patch({ company: "Other" })).status, 401);
  assert.equal((await readiness()).status, 401);
  signedIn = true;
});

test("settings read the current workspace's saved brand and scheduling zone", async () => {
  scopes.length = 0;
  const response = await GET();
  const data = await response.json();
  assert.equal(data.email, "owner@example.com");
  assert.equal(data.settings.timezone, "Asia/Kolkata");
  assert.equal(data.settings.description, "Operations software");
  assert.equal(data.settings.language, "Hindi");
  assert.ok(scopes.some(([key, value]) => key === "id" && value === "workspace-1"));
  assert.ok(!scopes.some(([key]) => key === "owner_id"));
});

test("settings carry the signed-in person's Google name and photo", async () => {
  // The workspace's company name is not the user: the avatar next to
  // "Signed in as" is theirs, so it needs `profiles`, not `brand_profile`.
  const data = await (await GET()).json();
  assert.equal(data.name, "Dev Dubey");
  assert.equal(data.avatarUrl, "https://lh3.googleusercontent.com/a/photo");
});

test("saving brand voice preserves product facts, artwork and channel data", async () => {
  saved = null;
  const response = await patch({ tone: "educational", audience: "Founders", voiceGuidelines: "Use plain language" });
  assert.equal(response.status, 200);
  const next = (saved as Record<string, unknown> | null)?.brand_profile as typeof profile;
  assert.equal(next.tone, "educational");
  assert.equal(next.voiceGuidelines, "Use plain language");
  assert.equal(next.audience, "Founders");
  // The website reading is left exactly as it was found. It used to be
  // overwritten with whatever the user typed, which made the two tiers
  // identical and destroyed the only signal distinguishing an answer from an
  // observation — the thing /api/settings now reports as `sources`.
  assert.equal((next.analysis as Record<string, unknown>).targetAudience, "Teams");
  assert.equal((next.analysis as Record<string, unknown>).description, "Operations software");
  assert.deepEqual(next.brandKit, profile.brandKit);
  assert.deepEqual(next.ads, profile.ads);
});

test("company, website and product details become real workflow brand context", async () => {
  const response = await patch({ company: "Acme Tools", website: "https://acme.example", description: "Approval tools for agencies" });
  assert.equal(response.status, 200);
  assert.equal(saved?.name, "Acme Tools");
  profile = saved?.brand_profile as typeof profile;
  const result = await (await readiness()).json();
  assert.equal(result.readiness.knowsProduct, true);
  assert.equal(result.readiness.summary, "Approval tools for agencies");
});

test("workspace timezone changes use the same atomic workspace write", async () => {
  assert.equal((await patch({ timezone: "Europe/London" })).status, 200);
  assert.equal(saved?.timezone, "Europe/London");
});

test("invalid settings are rejected before any write", async () => {
  for (const value of [null, [], { timezone: "Mars/Olympus" }, { company: "" }, { website: "javascript:alert(1)" }, { tone: 12 }]) {
    saved = null;
    assert.equal((await patch(value)).status, 400);
    assert.equal(saved, null);
  }
});

test("an update denied by workspace RLS cannot report success", async () => {
  writable = false;
  assert.equal((await patch({ company: "Denied" })).status, 403);
  writable = true;
});

test("a failed profile read leaves readiness unknown and never overwrites settings", async () => {
  failure = true;
  saved = null;
  assert.equal((await GET()).status, 500);
  assert.equal((await patch({ company: "Lost" })).status, 500);
  assert.equal(saved, null);
  const result = await (await readiness()).json();
  assert.equal(result.unknown, true);
  assert.equal(result.readiness.knowsProduct, true);
  failure = false;
});

test("existing Zidane databases read and save their workspace-scoped scheduling timezone", async () => {
  legacySchema = true;
  savedTimezone = "Asia/Tokyo";
  scopes.length = 0;
  try {
    const data = await (await GET()).json();
    assert.equal(data.settings.timezone, "Asia/Tokyo");
    assert.equal((await patch({ timezone: "Europe/Berlin" })).status, 200);
    assert.equal(savedTimezone, "Europe/Berlin");
    assert.equal(saved?.timezone, undefined, "legacy workspaces have no timezone column");
    assert.ok(scopes.some(([key, value]) => key === "workspace_id" && value === "workspace-1"));
  } finally {
    legacySchema = false;
  }
});

test("settings says which answers are the user's and which came off the website", async () => {
  signedIn = true;
  failure = false;
  profile = {
    company: "Acme",
    // Told to us directly.
    description: "Approval tools for agencies",
    // Only ever read off the homepage — never confirmed by anyone.
    analysis: { targetAudience: "Teams", voice: "plain-spoken" },
  };

  const data = await (await GET()).json();

  assert.equal(data.sources.description, "user");
  assert.equal(data.sources.audience, "site");
  assert.equal(data.sources.tone, "site");
  // The value still surfaces in the form; the label is what changes.
  assert.equal(data.settings.audience, "Teams");
  assert.equal(data.settings.tone, "plain-spoken");
});

test("a field nobody has answered is reported as unset rather than guessed", async () => {
  signedIn = true;
  failure = false;
  profile = { company: "Acme" };

  const data = await (await GET()).json();

  assert.equal(data.sources.description, "none");
  assert.equal(data.sources.tone, "none");
  assert.equal(data.sources.audience, "none");
});

test("persona and solo-or-team round-trip, and reject values off the list", async () => {
  signedIn = true;
  failure = false;
  writable = true;
  profile = { company: "Acme" };
  saved = null;

  assert.equal((await patch({ persona: "wizard" })).status, 400);
  assert.equal(saved, null);

  const ok = await patch({ persona: "founder", audienceMode: "team" });

  assert.equal(ok.status, 200);
  const next = (saved as Record<string, unknown> | null)?.brand_profile as Record<string, unknown>;
  assert.equal(next.persona, "founder");
  assert.equal(next.audienceMode, "team");
});
