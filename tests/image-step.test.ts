import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The image step's contract with the rest of the workflow engine.
 *
 * The generation itself belongs to `generateImages` and is covered by nothing
 * here on purpose — what this file pins is the part that is specific to running
 * inside an automation: that the workspace's own product photos and brand
 * styling reach the model, that a placeholder produced without a provider key
 * cannot be published as if it were real, and that a failure gives the credits
 * back. Each of those is a way the step could look like it worked and not have.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

let lastInput: { prompt: string; aspect: string; assetUrls?: string[] } | null = null;
let provider: "gpt-image-2" | "simulated" = "gpt-image-2";
let generateThrows = false;
let archiveTo: string | null = "https://cdn.example.com/ws-1/1.png";
const ledger: { delta: number; reason: string }[] = [];

mock.module("@/lib/ai/image", {
  namedExports: {
    MAX_REFERENCE_ASSETS: 4,
    generateImages: async (input: typeof lastInput) => {
      lastInput = input;
      if (generateThrows) throw new Error("All image providers failed");
      return { images: [{ b64: "AAAA" }], provider };
    },
    archiveImages: async () => [archiveTo],
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => ({
      assets: ["a.png", "b.png", "c.png", "d.png", "e.png"],
    }),
    brandContext: () => "",
    brandVideoHint: () => " Match the brand identity — use the brand palette #ff0000.",
  },
});

mock.module("@/lib/credits", {
  namedExports: {
    CREDIT_COST: { image_generation: 5 },
    spendCredits: async (_ws: string, amount: number, reason: string) => {
      ledger.push({ delta: -amount, reason });
      return { ok: true, outcome: "charged", balance: 100, cost: amount };
    },
    grantCredits: async (_ws: string, amount: number, reason: string, ref: string) => {
      ledger.push({ delta: amount, reason: `${reason}:${ref}` });
      return { ok: true };
    },
  },
});

const { HANDLERS } = await import("@/lib/workflows/steps");

async function run(step: Record<string, unknown> = {}) {
  lastInput = null;
  ledger.length = 0;
  return HANDLERS.generate_image({
    runId: "run-1",
    stepId: "make_image",
    step: { type: "generate_image", prompt: "the product on a clean desk", ...step },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
  } as never);
}

test("the brand's own product photos and styling reach the model", async () => {
  await run();
  // Capped at MAX_REFERENCE_ASSETS — the provider rejects more, and silently
  // sending five would fail the whole generation rather than drop the fifth.
  assert.equal(lastInput?.assetUrls?.length, 4);
  assert.ok(
    lastInput?.prompt.includes("#ff0000"),
    "brandVideoHint must be appended, or the image is on-brand by luck only",
  );
  assert.ok(lastInput?.prompt.startsWith("the product on a clean desk"));
});

test("opting out of assets generates from the description alone", async () => {
  await run({ useAssets: "no" });
  assert.deepEqual(lastInput?.assetUrls, []);
});

test("an unknown shape falls back to square rather than reaching the provider", async () => {
  const out = await run({ aspect: "panoramic" });
  assert.equal(lastInput?.aspect, "square");
  assert.equal((out as { aspect: string }).aspect, "square");
});

test("a placeholder image is marked simulated, so it can never be published", async () => {
  provider = "simulated";
  const out = await run();
  // Without this flag the placehold.co card is a URL like any other and
  // social_post puts it on a real account.
  assert.equal((out as { sim?: boolean }).sim, true);
  provider = "gpt-image-2";

  const real = await run();
  assert.equal((real as { sim?: boolean }).sim, undefined);
});

test("the step is charged once, and refunded when the provider fails", async () => {
  const ok = await run();
  assert.equal((ok as { url: string }).url, "https://cdn.example.com/ws-1/1.png");
  assert.deepEqual(ledger, [{ delta: -5, reason: "image_generation" }]);

  generateThrows = true;
  await assert.rejects(run());
  assert.deepEqual(ledger, [
    { delta: -5, reason: "image_generation" },
    { delta: 5, reason: "refund:image_provider_failed" },
  ]);
  generateThrows = false;
});

test("an image we generated but could not store is refunded, not returned", async () => {
  archiveTo = null;
  // Returning a null url would hand social_post an empty mediaUrl and charge
  // for it; the run has to fail instead.
  await assert.rejects(run(), /could not be stored/);
  assert.deepEqual(ledger, [
    { delta: -5, reason: "image_generation" },
    { delta: 5, reason: "refund:image_archive_failed" },
  ]);
  archiveTo = "https://cdn.example.com/ws-1/1.png";
});

test("a step with no description fails before it charges anything", async () => {
  await assert.rejects(run({ prompt: "   " }), /no description/);
  assert.deepEqual(ledger, []);
});
