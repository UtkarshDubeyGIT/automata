import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import {
  claimWorkflowBuild,
  deleteExpiredWorkflowBuilds,
  enqueueWorkflowBuild,
  runWorkflowBuild,
  type BuildJobDb,
  type WorkflowBuildJob,
} from "@/lib/workflows/build-jobs";
import {
  pollWorkflowBuild,
  requestWorkflowBuild,
  resetPendingBuildKeys,
  startWorkflowBuild,
} from "@/lib/workflows/build-request";
import type { BuildOutput } from "@/lib/workflows/builder";

test("durable workflow builds have a queue and a client request seam", () => {
  assert.equal(existsSync("src/lib/workflows/build-jobs.ts"), true);
  assert.equal(existsSync("src/lib/workflows/build-request.ts"), true);
  assert.equal(existsSync("src/app/api/workflows/build/[id]/route.ts"), true);
  const migration = readFileSync(
    "supabase/migrations/20260902090000_durable_workflow_builds.sql",
    "utf8",
  );
  assert.match(migration, /create table if not exists public\.workflow_builds/);
  assert.match(migration, /create or replace function public\.enqueue_workflow_build/);
  assert.match(migration, /drop policy if exists "ws access" on public\.credit_ledger/);
  assert.match(migration, /p_cost <> 3/);
  assert.match(migration, /credit_ledger_serialize_debit/);
  assert.match(migration, /Idempotency wins before affordability/);
});

test("the builder bounds provider calls inside the job lease", () => {
  const source = readFileSync("src/lib/workflows/builder.ts", "utf8");
  assert.match(source, /options\?: \{ deadline\?: number \}/);
  assert.match(source, /timeoutMs: remainingBuildTime\(deadline\)/);
});

test("the unknown enqueue fallback is reserved for an unconfirmed enqueue", () => {
  const source = readFileSync("src/app/(app)/workflows/builder-chat.tsx", "utf8");
  const fallback = "I couldn't reach the builder — check that the app is running, then try again.";
  assert.equal(source.split(fallback).length - 1, 1);
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("an accepted build request returns its durable job immediately", async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    return json({ job: { id: "build-1", status: "queued" } }, 202);
  }) as typeof fetch;

  const outcome = await startWorkflowBuild("Post weekly", "request-1", fetchImpl);

  assert.deepEqual(outcome, {
    kind: "accepted",
    job: { id: "build-1", status: "queued" },
  });
  assert.deepEqual(JSON.parse(String(calls[0].body)), {
    prompt: "Post weekly",
    requestKey: "request-1",
  });
});

test("a proxy page on initial enqueue stays the final unknown fallback", async () => {
  const fetchImpl = (async () => new Response("<html>Bad gateway</html>", { status: 504 })) as typeof fetch;
  assert.deepEqual(await startWorkflowBuild("Post weekly", "request-1", fetchImpl), {
    kind: "unknown",
    reason: "gateway",
  });
});

test("an unanswered enqueue reuses its key on the next attempt", async () => {
  resetPendingBuildKeys();
  const bodies: { requestKey: string }[] = [];
  let attempt = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)) as { requestKey: string });
    attempt++;
    return attempt === 1
      ? new Response("<html>Bad gateway</html>", { status: 504 })
      : json({ job: { id: "build-1", status: "queued" } }, 202);
  }) as typeof fetch;

  assert.equal((await requestWorkflowBuild("Post weekly", fetchImpl)).kind, "unknown");
  assert.equal((await requestWorkflowBuild("Post weekly", fetchImpl)).kind, "accepted");
  assert.equal(bodies[0].requestKey, bodies[1].requestKey);
});

test("a temporary status read failure asks the UI to keep polling", async () => {
  const fetchImpl = (async () => {
    throw new TypeError("network down");
  }) as typeof fetch;
  assert.deepEqual(await pollWorkflowBuild("build-1", fetchImpl), { kind: "retry" });
});

test("a completed status response carries the stored build", async () => {
  const build = sampleBuild();
  const fetchImpl = (async () => json({ job: { id: "build-1", status: "completed", build } })) as typeof fetch;
  assert.deepEqual(await pollWorkflowBuild("build-1", fetchImpl), {
    kind: "job",
    job: { id: "build-1", status: "completed", build },
  });
});

test("enqueue is one atomic database operation keyed by the browser request", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const job = sampleJob();
  const db = {
    from() {
      throw new Error("enqueue must not split job creation from charging");
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return {
        data: { outcome: "queued", job, duplicate: false, balance: 97, cost: 3 },
        error: null,
      };
    },
  } as unknown as BuildJobDb;

  assert.deepEqual(
    await enqueueWorkflowBuild(db, {
      workspaceId: "ws-1",
      requestKey: "request-1",
      prompt: "Post weekly",
    }),
    { outcome: "queued", job, duplicate: false, balance: 97, cost: 3 },
  );
  assert.equal(calls[0].name, "enqueue_workflow_build");
  assert.deepEqual(calls[0].args, {
    p_workspace_id: "ws-1",
    p_request_key: "request-1",
    p_prompt: "Post weekly",
    p_cost: 3,
  });
});

test("two workers cannot claim the same queued build", async () => {
  const db = buildDb(sampleJob());
  const [first, second] = await Promise.all([
    claimWorkflowBuild(db, "build-1", "worker-a"),
    claimWorkflowBuild(db, "build-1", "worker-b"),
  ]);
  assert.equal([first, second].filter(Boolean).length, 1);
});

test("a successful worker stores the build under its own lease", async () => {
  const db = buildDb(sampleJob());
  const build = sampleBuild();
  let calls = 0;

  const result = await runWorkflowBuild(db, "build-1", {
    holder: "worker-a",
    build: async () => {
      calls++;
      return build;
    },
  });

  assert.equal(calls, 1);
  assert.equal(result?.status, "completed");
  assert.deepEqual(result?.result, build);
});

test("a failed build refunds once, even when recovery sees it again", async () => {
  const db = buildDb(sampleJob());
  let refunds = 0;
  const deps = {
    build: async () => {
      throw new Error("provider unavailable");
    },
    refund: async () => {
      refunds++;
    },
  };

  const first = await runWorkflowBuild(db, "build-1", deps);
  const second = await runWorkflowBuild(db, "build-1", deps);

  assert.equal(first?.status, "failed");
  assert.equal(second?.status, "failed");
  assert.equal(refunds, 1);
  assert.ok(second?.refunded_at);
});

test("a refund outage leaves a failed job recoverable without rebuilding", async () => {
  const db = buildDb(sampleJob());
  let builds = 0;
  let refunds = 0;

  const first = await runWorkflowBuild(db, "build-1", {
    build: async () => {
      builds++;
      throw new Error("provider unavailable");
    },
    refund: async () => {
      refunds++;
      throw new Error("ledger unavailable");
    },
  });
  const second = await runWorkflowBuild(db, "build-1", {
    build: async () => {
      builds++;
      return sampleBuild();
    },
    refund: async () => {
      refunds++;
    },
  });

  assert.equal(first?.status, "failed");
  assert.equal(first?.refunded_at, null);
  assert.equal(second?.status, "failed");
  assert.equal(builds, 1);
  assert.equal(refunds, 2);
  assert.ok(second?.refunded_at);
});

test("expiry never deletes a failed build before its refund lands", async () => {
  const db = new FakeDb();
  const expired = "2026-09-01T00:00:00.000Z";
  db.seed(
    "workflow_builds",
    { ...sampleJob(), id: "completed", status: "completed", expires_at: expired },
    { ...sampleJob(), id: "unrefunded", status: "failed", expires_at: expired },
    {
      ...sampleJob(),
      id: "refunded",
      status: "failed",
      refunded_at: "2026-09-01T00:00:00.000Z",
      expires_at: expired,
    },
  );

  await deleteExpiredWorkflowBuilds(
    db as unknown as BuildJobDb,
    new Date("2026-09-02T00:00:00.000Z"),
  );

  assert.deepEqual(db.table("workflow_builds").map((row) => row.id), ["unrefunded"]);
});

function buildDb(job: WorkflowBuildJob): BuildJobDb {
  const db = new FakeDb();
  db.seed("workflow_builds", structuredClone(job) as unknown as Record<string, unknown>);
  return Object.assign(db, {
    rpc: async () => ({ data: null, error: null }),
  }) as unknown as BuildJobDb;
}

function sampleJob(): WorkflowBuildJob {
  return {
    id: "build-1",
    workspace_id: "ws-1",
    request_key: "request-1",
    prompt: "Post weekly",
    status: "queued",
    result: null,
    error: null,
    error_code: null,
    attempts: 0,
    claimed_at: null,
    claimed_by: null,
    charged_at: "2026-09-02T10:00:00.000Z",
    refunded_at: null,
    available_at: "2026-09-02T10:00:00.000Z",
    expires_at: "2026-09-03T10:00:00.000Z",
  };
}

function sampleBuild(): BuildOutput {
  return {
    name: "Weekly post",
    description: "Draft a weekly post.",
    config: {
      v: 1,
      prompt: "Post weekly",
      display: { groups: [] },
      graph: {
        start: "start",
        steps: {
          start: { type: "manual_trigger_input", next: null },
        },
      },
    },
    response: [[{ t: "Ready." }]],
    groups: [],
    simulated: false,
    requiredApps: [],
    needsBrand: false,
  };
}
