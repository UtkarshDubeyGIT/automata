import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { NextRequest } from "next/server";

const calls: string[] = [];
const db = {};
let videoFails = false;
const count = (name: string) => async () => {
  calls.push(name);
  return { examined: 0 };
};

mock.module("@/lib/env", { namedExports: { env: { cronSecret: "test-cron-secret" }, supabaseConfigured: true } });
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => db } });
mock.module("@/lib/jobs/lock", { namedExports: { claimJob: async () => ({ ok: true, release: count("release") }) } });
mock.module("@/lib/workflows/drain", { namedExports: {
  drainRuns: count("runs"), reclaimStuckRuns: count("reclaims"), resumeRenders: count("renders"),
} });
mock.module("@/lib/workflows/sweep", { namedExports: { sweepTriggers: count("triggers") } });
mock.module("@/lib/workflows/build-jobs", { namedExports: { kickWorkflowBuilds: count("builds") } });
mock.module("@/lib/whatsapp/service", { namedExports: { drainWhatsAppDeliveries: count("whatsapp") } });
mock.module("@/lib/video/advance", { namedExports: { sweepVideos: async () => {
  calls.push("videos");
  if (videoFails) throw new Error("Video provider unavailable");
  return { examined: 0 };
} } });

const route = await import("@/app/api/cron/route") as {
  GET?: (request: NextRequest) => Promise<Response>;
  POST: (request: NextRequest) => Promise<Response>;
};

test("Vercel's authenticated GET runs the same durable automation beat as POST", async () => {
  assert.equal(typeof route.GET, "function", "GET must be supported for the configured Vercel cron");
  calls.length = 0;
  const request = new Request("http://localhost/api/cron", {
    headers: { authorization: "Bearer test-cron-secret" },
  }) as NextRequest;
  const response = await route.GET!(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.deepEqual(calls, ["builds", "triggers", "renders", "runs", "reclaims", "whatsapp", "release", "videos"]);
});

test("GET cron rejects unauthenticated visitors before any automation executes", async () => {
  assert.equal(typeof route.GET, "function");
  calls.length = 0;
  const response = await route.GET!(new Request("http://localhost/api/cron") as NextRequest);
  assert.equal(response.status, 401);
  assert.deepEqual(calls, []);
});

test("the VM worker can still authenticate its POST with the shared cron header", async () => {
  calls.length = 0;
  const response = await route.POST(new Request("http://localhost/api/cron", {
    method: "POST", headers: { "x-cron-secret": "test-cron-secret" },
  }) as NextRequest);
  assert.equal(response.status, 200);
  assert.ok(calls.includes("runs"));
});

test("a failed video sweep cannot prevent workflow draining or hold the workflow beat lock", async () => {
  calls.length = 0;
  videoFails = true;
  const logged = mock.method(console, "error", () => {});
  try {
    const response = await route.POST(new Request("http://localhost/api/cron", {
      method: "POST", headers: { "x-cron-secret": "test-cron-secret" },
    }) as NextRequest);
    assert.equal(response.status, 200);
    assert.ok(calls.indexOf("runs") >= 0);
    assert.ok(calls.indexOf("release") < calls.indexOf("videos"));
  } finally {
    videoFails = false;
    logged.mock.restore();
  }
});
