import { strict as assert } from "node:assert";
import { setImmediate } from "node:timers/promises";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import * as specs from "@/lib/video/specs";
import type { Take } from "@/lib/video/stitch";

const db = new FakeDb();
const calls: string[] = [];
const refunds: unknown[][] = [];
mock.module("@/lib/env", {
  namedExports: { env: { supabaseUrl: "https://media.example" }, supabaseConfigured: true },
});
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => db } });
mock.module("@/lib/credits", {
  namedExports: {
    CREDIT_COST: { video_ugc: 30, video_shortform: 30, video_cinematic: 30, video_avatar: 30, video_demo: 30 },
    spendCredits: async () => ({ ok: true, balance: 970 }),
    grantCredits: async (...args: unknown[]) => { refunds.push(args); },
  },
});
mock.module("@/lib/brand", {
  namedExports: { getBrandProfileForWorkspace: async () => null, brandVideoHint: () => "" },
});
mock.module("@/lib/ai/content", { namedExports: { CONTENT_TONES: [] } });
mock.module("@/lib/video/brief", { namedExports: { visualBrief: async () => "A product on a desk" } });
mock.module("@/lib/video/plan", {
  namedExports: {
    buildPlan: async () => {
      calls.push("plan");
      return {
        script: "A clearer daily routine.", cta: "Try it", critique: "Specific to the product", considered: 3,
        styleAnchor: "A quiet desk",
        shots: [{ index: 0, kind: "generated", line: "A clearer daily routine.", visual: "A product on a desk", direction: "Slow pan" }],
      };
    },
  },
});
mock.module("@/lib/video/keyframes", {
  namedExports: {
    buildKeyframes: async () => {
      calls.push("keyframe");
      return { masterUrl: "https://media.example/master.png", byShot: { 0: "https://media.example/master.png" }, masterProblems: [], derived: 0, reused: 0 };
    },
  },
});
mock.module("@/lib/video/capture-step", {
  namedExports: { awaitingCapture: () => false, captureStep: async () => { throw new Error("Unexpected capture"); } },
});
mock.module("@/lib/video/capture", {
  namedExports: { captureShotClip: async () => { throw new Error("Unexpected capture"); } },
});
mock.module("@/lib/video/validate", {
  namedExports: {
    validateKeyframe: async () => ({ checked: true, ok: true, problems: [] }),
    validateRenderedShot: async () => ({ checked: true, ok: true, problems: [] }),
  },
});
mock.module("@/lib/video/higgsfield", {
  namedExports: {
    ...specs,
    PROVIDER_CREDITS_PER_TAKE: 9,
    submitTake: async () => { calls.push("submit"); return "provider-take-1"; },
    videoProvider: {
      status: async () => ({ status: "completed", url: "https://provider.example/take.mp4", kind: "shortform" }),
    },
  },
});
mock.module("@/lib/video/archive", {
  namedExports: { archiveVideoRow: async () => "https://media.example/archived.mp4" },
});
mock.module("@/lib/video/stitch", {
  namedExports: {
    parseTakes: (value: unknown): Take[] => Array.isArray(value) ? value : [],
    renderedTakes: (takes: Take[]) => takes.filter((take) => take.url && !take.failed),
    pendingTakes: (takes: Take[]) => takes.filter((take) => !take.url && !take.failed),
    isLocalTake: (take: Take) => take.requestId.startsWith("local:"),
    storeTake: async () => ({ url: "https://media.example/take.mp4", seconds: 5 }),
    concatTakes: async () => {
      calls.push("assemble");
      return { url: "https://media.example/silent.mp4", durationSec: 5 };
    },
  },
});
mock.module("@/lib/video/postproduce", {
  namedExports: {
    missingMediaTools: async () => null,
    addVoiceover: async () => {
      calls.push("narrate");
      return { status: "ok", url: "https://media.example/final.mp4", durationSec: 5, script: "A clearer daily routine." };
    },
  },
});

const { queueVideos } = await import("@/lib/video/queue");
const { driveVideoJobs, isDriving } = await import("@/lib/video/runner");

async function queue() {
  const result = await queueVideos({
    db, workspaceId: "workspace-1", profile: { company: "Acme" }, kind: "shortform",
    prompt: "Show the product", aspectRatio: "9:16", durationSec: 5, idemKey: "workflow-run:video-step",
  });
  if (!result.ok) throw new Error(result.error);
  return result.jobs[0].id;
}

test("a queued workflow video is planned, rendered, assembled and voiced by the background runner", async (t) => {
  db.replace("videos", []);
  calls.length = 0;
  refunds.length = 0;
  const id = await queue();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  driveVideoJobs([id]);
  driveVideoJobs([id]);
  assert.equal(isDriving(id), true);

  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(db.table("videos")[0].plan_status, "done");
  t.mock.timers.tick(10_000);
  await setImmediate();
  assert.equal(db.table("videos")[0].keyframe_status, "done");
  t.mock.timers.tick(10_000);
  await setImmediate();

  const video = db.table("videos")[0];
  assert.equal(isDriving(id), false);
  assert.equal(video.status, "completed");
  assert.equal(video.voiceover_status, "done");
  assert.equal(video.url, "https://media.example/final.mp4");
  assert.deepEqual(calls, ["plan", "keyframe", "submit", "assemble", "narrate"]);
  assert.deepEqual(refunds, []);
});

test("an abandoned paid render is failed and refunded once instead of remaining queued forever", async (t) => {
  db.replace("videos", []);
  refunds.length = 0;
  calls.length = 0;
  const id = await queue();
  db.table("videos")[0].created_at = new Date(Date.now() - 46 * 60_000).toISOString();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  driveVideoJobs([id]);
  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(db.table("videos")[0].status, "failed");
  assert.equal(refunds.length, 1);
  assert.deepEqual(calls, []);

  driveVideoJobs([id]);
  t.mock.timers.tick(500);
  await setImmediate();
  assert.equal(isDriving(id), false);
  assert.equal(refunds.length, 1);
});
