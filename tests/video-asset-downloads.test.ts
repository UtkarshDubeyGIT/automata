import assert from "node:assert/strict";
import { mock, test } from "node:test";
import * as environment from "@/lib/env";
import * as videoSpecs from "@/lib/video/specs";
import { FakeDb } from "./helpers/fake-supabase";

const db = Object.assign(new FakeDb(), {
  storage: { from: () => ({
    upload: async () => ({ error: null }),
    getPublicUrl: () => ({ data: { publicUrl: "https://storage.example/asset" } }),
  }) },
});
mock.module("@/lib/env", { namedExports: {
  ...environment, env: { ...environment.env, supabaseUrl: "https://storage.example", openaiKey: "fixture" }, openaiConfigured: true,
} });
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => db } });
mock.module("@/lib/video/probe", { namedExports: {
  missingMediaTools: async () => null,
  probeDuration: async () => 5,
  probeDimensions: async () => ({ width: 1920, height: 1080 }),
  hasAudio: async () => true,
} });
let generatedFrameUrl = "";
mock.module("@/lib/video/higgsfield", { namedExports: {
  ...videoSpecs, generateKeyframe: async () => generatedFrameUrl,
} });
mock.module("openai", { namedExports: { toFile: async () => new File([], "fixture") }, defaultExport: class {
  chat = { completions: { create: async () => { throw new Error("Vision unavailable in fixture"); } } };
} });

const { archiveVideoRow } = await import("@/lib/video/archive");
const { storeTake } = await import("@/lib/video/stitch");
const { buildKeyframes } = await import("@/lib/video/keyframes");
const { validateKeyframe } = await import("@/lib/video/validate");
const { addVoiceover } = await import("@/lib/video/postproduce");
const shot = { index: 0, kind: "generated" as const, visual: "A public product", line: "A product", direction: "Still" };

const stages: Record<string, (url: string) => Promise<void>> = {
  archive: async (url) => {
    db.replace("videos", [{ id: "video", workspace_id: "workspace", job_id: "job", url }]);
    assert.equal(await archiveVideoRow("job"), null);
    assert.equal(db.table("videos")[0].url, url);
  },
  stitch: async (url) => {
    await assert.rejects(storeTake({ sourceUrl: url, workspaceId: "workspace", jobId: "job", index: 0 }), /public HTTP/);
  },
  keyframe: async (url) => {
    generatedFrameUrl = url;
    const frames = await buildKeyframes({
      workspaceId: "workspace", jobId: "job", profile: null, kind: "shortform", ratio: "16:9",
      plan: { script: "A product", cta: "Try it", critique: "", considered: 1, styleAnchor: "Plain", shots: [shot] },
    });
    assert.equal(frames.masterUrl, url, "a failed mirror keeps the existing master fallback");
  },
  validation: async (url) => {
    const result = await validateKeyframe({ frameUrl: url, shot });
    assert.equal(result.checked, false, "an unavailable inspection stays advisory");
  },
  narration: async (url) => {
    const result = await addVoiceover({ videoUrl: url, workspaceId: "workspace", jobId: "job", kind: "shortform", prompt: "A product" });
    assert.equal(result.status, "failed");
  },
};

for (const [stage, run] of Object.entries(stages)) {
  test(`${stage} refuses private media and public redirects into the worker network`, async (t) => {
    const fetched: string[] = [];
    t.mock.method(console, "error", () => {});
    t.mock.method(console, "log", () => {});
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      fetched.push(url);
      if (url === "http://203.0.113.10/asset") {
        if (init?.redirect === "manual") {
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/private" } });
        }
        fetched.push("http://169.254.169.254/private");
      }
      return new Response(Buffer.alloc(300), { headers: { "content-type": "image/png" } });
    });
    await run("http://127.0.0.1/private");
    assert.deepEqual(fetched, [], "a private destination must not reach fetch");
    await run("http://203.0.113.10/asset");
    assert.deepEqual(fetched, ["http://203.0.113.10/asset"], "redirect destinations must be validated before fetching");
  });
}

test("public media can still be archived into durable workspace storage", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(Buffer.alloc(300), { headers: { "content-type": "video/mp4" } }));
  db.replace("videos", [{ id: "video", workspace_id: "workspace", job_id: "job", url: "http://203.0.113.10/clip.mp4" }]);
  assert.equal(await archiveVideoRow("job"), "https://storage.example/asset");
  assert.equal(db.table("videos")[0].url, "https://storage.example/asset");
});
