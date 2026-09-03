import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * The video step's contract with the engine.
 *
 * Rendering itself belongs to `lib/video` and is not tested here. What this
 * pins is the part that only exists because a video runs inside an automation:
 * a render takes minutes, so the step CANNOT return the way every other step
 * does. It queues, parks the run, and is re-driven later — and the whole
 * design rests on that second execution being able to tell "I have never run"
 * from "the clip I already paid for is still rendering". Get that wrong and
 * every beat queues another video and charges for it.
 */

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

let queued: Record<string, unknown>[] = [];
let started: string[][] = [];
let videoRow: Record<string, unknown> | null = null;
let queueFails: string | null = null;

mock.module("@/lib/video/queue", {
  namedExports: {
    queueVideos: async (input: Record<string, unknown>) => {
      if (queueFails) return { ok: false, reason: "credits", error: queueFails, balance: 0 };
      queued.push(input);
      return {
        ok: true,
        cost: 30,
        jobs: [{ id: `vid_${queued.length}`, status: "queued", kind: input.kind }],
      };
    },
    startRendering: (jobs: { id: string }[]) => started.push(jobs.map((j) => j.id)),
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => ({
      company: "Experiments",
      website: "https://dubey.page",
      analysis: { description: "a personal portfolio" },
    }),
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: videoRow }) }),
        }),
      }),
    }),
  },
});

const { Await, HANDLERS } = await import("@/lib/workflows/steps");

interface Parked {
  kind: "video";
  stepId: string;
  ref: string;
  note: string;
  since: string;
}

async function run(step: Record<string, unknown> = {}, awaiting?: Parked) {
  return HANDLERS.generate_video({
    runId: "run-1",
    stepId: "film",
    step: { type: "generate_video", prompt: "the product on a desk", ...step },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
    ...(awaiting ? { awaiting } : {}),
  } as never);
}

function parked(ref = "vid_1", since = new Date().toISOString()): Parked {
  return { kind: "video", stepId: "film", ref, note: "Rendering a 10s video.", since };
}

test("the first execution queues one clip and parks the run", async () => {
  queued = [];
  started = [];
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Await, "the step must park the run, not return");
  assert.equal((err as InstanceType<typeof Await>).kind, "video");
  assert.equal((err as InstanceType<typeof Await>).ref, "vid_1");
  assert.equal(queued.length, 1);
  // Rendering starts immediately rather than at the next beat.
  assert.deepEqual(started, [["vid_1"]]);
});

test("the charge is keyed to the step, so a re-driven run pays once", async () => {
  queued = [];
  await run().catch(() => {});
  assert.equal(queued[0].idemKey, "wf:run-1:film");
});

test("the brand is frozen onto the row rather than read again mid-render", async () => {
  queued = [];
  await run().catch(() => {});
  const profile = queued[0].profile as { company?: string } | null;
  assert.equal(profile?.company, "Experiments");
  // The site is what a demo shot would record; passing it is what makes an
  // automation's clip as grounded as one made by hand on the Video page.
  assert.equal(queued[0].productUrl, "https://dubey.page");
});

test("a still-rendering clip parks again WITHOUT queueing a second one", async () => {
  queued = [];
  videoRow = { status: "processing", url: null, voiced_url: null, thumbnail_url: null, plan: null };
  const err = await run({}, parked()).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Await);
  // The whole point: a beat every fifteen minutes must not bill a video per beat.
  assert.equal(queued.length, 0, "a re-drive must never queue a second render");
});

test("a finished clip returns its NARRATED url, so the next step can publish it", async () => {
  videoRow = {
    status: "completed",
    url: "https://cdn.example.com/silent.mp4",
    voiced_url: "https://cdn.example.com/clip.mp4",
    voiceover_status: "done",
    thumbnail_url: "https://cdn.example.com/clip.jpg",
    plan: null,
    target_duration_sec: 10,
    kind: "shortform",
  };
  const out = (await run({}, parked())) as Record<string, unknown>;
  assert.equal(out.url, "https://cdn.example.com/clip.mp4");
  assert.equal(out.thumbnailUrl, "https://cdn.example.com/clip.jpg");
  // Grounding is stamped on the output itself, which is what lets the approval
  // card say who the clip was made for rather than guessing from the profile
  // as it stands at approval time.
  assert.equal(out.grounded, true);
  assert.equal(out.brand, "Experiments");
});

test("a failed render fails the run with the pipeline's own reason", async () => {
  // The reason lives in `plan.error` — there is no `error` column on `videos`,
  // and selecting one would make every read come back empty.
  videoRow = {
    status: "failed",
    url: null,
    voiced_url: null,
    thumbnail_url: null,
    plan: { error: "Keyframe rejected" },
  };
  await assert.rejects(run({}, parked()), /Keyframe rejected/);
});

test("a cut-together clip is not published while its narration is still coming", async () => {
  queued = [];
  // `completed` is written when the takes are joined, minutes before the
  // voiceover, captions and end card replace the file. Publishing here posts
  // the silent version of a video that was about to be finished.
  videoRow = {
    status: "completed",
    url: "https://cdn.example.com/silent.mp4",
    voiced_url: null,
    voiceover_status: null,
    thumbnail_url: null,
    plan: null,
  };
  const err = await run({}, parked()).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof Await, "it must keep waiting for the narrated cut");
  assert.equal(queued.length, 0);
});

test("but a narration that never lands does not cost the clip entirely", async () => {
  videoRow = {
    status: "completed",
    url: "https://cdn.example.com/silent.mp4",
    voiced_url: null,
    voiceover_status: null,
    thumbnail_url: null,
    plan: null,
  };
  const old = new Date(Date.now() - 80 * 60_000).toISOString();
  const out = (await run({}, parked("vid_1", old))) as Record<string, unknown>;
  // An assembled clip is genuinely usable; refusing to publish one over a
  // missing voiceover would be the worse failure.
  assert.equal(out.url, "https://cdn.example.com/silent.mp4");
  assert.equal(out.silent, true);
});

test("a render that outlives the horizon gives up rather than waiting forever", async () => {
  videoRow = { status: "processing", url: null, voiced_url: null, thumbnail_url: null, plan: null };
  const old = new Date(Date.now() - 80 * 60_000).toISOString();
  await assert.rejects(run({}, parked("vid_1", old)), /gave up/);
});

test("a vanished row is reported, not waited on", async () => {
  videoRow = null;
  await assert.rejects(run({}, parked()), /no longer exists/);
});

test("an unresolved reference refuses before anything is charged", async () => {
  queued = [];
  await assert.rejects(
    run({ prompt: "a clip about {{steps.draft.result.text}}" }),
    /unresolved reference/,
  );
  assert.equal(queued.length, 0);
});

test("an unknown style or shape falls back rather than reaching the provider", async () => {
  queued = [];
  await run({ kind: "interpretive-dance", aspectRatio: "7:3", durationSec: 900 }).catch(() => {});
  assert.equal(queued[0].kind, "shortform");
  assert.equal(queued[0].aspectRatio, "9:16");
  assert.ok(
    Number(queued[0].durationSec) <= 60,
    "a 900-second request must not be billed as 900 seconds of takes",
  );
});

test("a refused charge fails the step instead of parking on nothing", async () => {
  queueFails = "Not enough credits to render the video — it costs 30 and the balance is 2.";
  await assert.rejects(run(), /Not enough credits/);
  queueFails = null;
});
