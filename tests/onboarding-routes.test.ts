import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let signedIn = true;
let stored: Record<string, unknown> = {};
let savedWorkspace: Record<string, unknown> | null = null;
let savedProfile: Record<string, unknown> | null = null;

const supabase = {
  from(table: string) {
    assert.ok(["workspaces", "profiles"].includes(table));
    let updating = false;
    const query = {
      select: () => query,
      eq: () => query,
      update: (value: Record<string, unknown>) => {
        updating = true;
        if (table === "profiles") savedProfile = value;
        else savedWorkspace = value;
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

const { PATCH } = await import("@/app/api/onboarding/step/route");
const { POST } = await import("@/app/api/onboarding/complete/route");
const { brandKnowsProduct } = await import("@/lib/brand");

const body = (value: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(value),
});
const saveStep = (value: unknown) => PATCH(new Request("https://automata.example/api/onboarding/step", body(value)));
const complete = (value: unknown) => POST(new Request("https://automata.example/api/onboarding/complete", body(value)));

function reset(profile: Record<string, unknown> = {}) {
  signedIn = true;
  stored = profile;
  savedWorkspace = null;
  savedProfile = null;
}

test("onboarding writes require a signed-in workspace", async () => {
  reset();
  signedIn = false;

  assert.equal((await saveStep({ step: 1, values: { website: "acme.com" } })).status, 401);
  assert.equal((await complete({ skipped: true })).status, 401);
  assert.equal(savedWorkspace, null);
});

test("a step saves its own fields and ignores anything not on the whitelist", async () => {
  reset();

  const res = await saveStep({
    step: 3,
    values: { description: "We automate post-purchase email.", plan: "enterprise", credits: 999999 },
  });

  assert.equal(res.status, 200);
  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  assert.equal(profile.description, "We automate post-purchase email.");
  // `plan` and `credits` are real workspace columns behind a service-role grant.
  // They must not become writable just by riding along in an onboarding body.
  assert.equal("plan" in profile, false);
  assert.equal("credits" in profile, false);
  assert.equal("plan" in (savedWorkspace ?? {}), false);
});

test("going back to fix an earlier answer does not rewind the resume point", async () => {
  reset({ onboarding: { step: 4 } });

  await saveStep({ step: 2, values: { persona: "founder" } });

  const onboarding = (savedWorkspace?.brand_profile as Record<string, unknown>).onboarding as { step: number };
  assert.equal(onboarding.step, 4);
});

test("a website that cannot be parsed is refused rather than stored empty", async () => {
  reset();

  const res = await saveStep({ step: 1, values: { website: "not a website" } });

  assert.equal(res.status, 400);
  assert.equal(savedWorkspace, null);
});

test("a scheme-less website is normalized before it is stored", async () => {
  reset();

  await saveStep({ step: 1, values: { website: "acme.com" } });

  assert.equal((savedWorkspace?.brand_profile as Record<string, unknown>).website, "https://acme.com");
});

test("an unknown persona is dropped instead of being written through", async () => {
  reset();

  await saveStep({ step: 2, values: { persona: "wizard", audienceMode: "team" } });

  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  assert.equal("persona" in profile, false);
  assert.equal(profile.audienceMode, "team");
});

test("the name goes to the person's profile, not the workspace brand", async () => {
  reset();

  await saveStep({ step: 0, values: { name: "Ada Lovelace" } });

  assert.deepEqual(savedProfile, { full_name: "Ada Lovelace" });
  assert.equal("name" in (savedWorkspace?.brand_profile as Record<string, unknown>), false);
});

test("skipping writes no brand fields at all", async () => {
  reset();

  const res = await complete({ skipped: true, step: 2 });

  assert.equal(res.status, 200);
  assert.equal(savedWorkspace?.onboarded, true);
  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  // The whole point: no invented tone, no invented description. An absent field
  // is omitted by brandContext(), so the AI ends up with no voice rather than a
  // voice the user never chose — and BrandGap still knows to prompt for one.
  assert.deepEqual(Object.keys(profile), ["onboarding"]);
  assert.equal((profile.onboarding as { skipped: boolean }).skipped, true);
  assert.equal(brandKnowsProduct(profile), false);
});

test("skipping preserves answers already given before the user bailed", async () => {
  reset({ website: "https://acme.com", persona: "founder" });

  await complete({ skipped: true, step: 3 });

  const profile = savedWorkspace?.brand_profile as Record<string, unknown>;
  assert.equal(profile.website, "https://acme.com");
  assert.equal(profile.persona, "founder");
});

test("finishing marks the workspace onboarded and records that it was not skipped", async () => {
  reset({ description: "We automate post-purchase email." });

  await complete({ skipped: false, step: 5 });

  assert.equal(savedWorkspace?.onboarded, true);
  const onboarding = (savedWorkspace?.brand_profile as Record<string, unknown>).onboarding as {
    skipped: boolean;
    completedAt: string;
    step: number;
  };
  assert.equal(onboarding.skipped, false);
  assert.equal(onboarding.step, 5);
  assert.ok(Date.parse(onboarding.completedAt) > 0);
});
