import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Polling an app_event trigger — the two ways a poll can lie.
 *
 * Both of these shipped: a trigger whose target was a stand-in the builder
 * invented polled anyway and recorded GitHub's 404 as if the repository were
 * simply quiet; and a poll that FAILED still baselined the cursor, so the first
 * poll that later succeeded treated the whole page as new.
 */

const db = new FakeDb();
mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => db, createClient: async () => db },
});

/** Every executeTool call the sweep makes, and what it gets back. */
const calls: { slug: string; args: Record<string, unknown> }[] = [];
let reply: { successful: boolean; data?: unknown; error?: string } = {
  successful: true,
  data: { items: [] },
};

mock.module("@/lib/social/composio", {
  namedExports: {
    executeTool: async (slug: string, _ws: string, args: Record<string, unknown>) => {
      calls.push({ slug, args });
      return reply;
    },
    socialProvider: {
      // Live, so the sweep takes the real polling branch rather than the
      // no-provider short circuit that hides both defects.
      live: true,
      listConnections: async () => [{ platform: "github", status: "connected" }],
    },
    PLATFORMS: [],
    platformMeta: () => undefined,
    normalizeSlug: (id: string) => id,
    toolkitLogo: () => "",
    CHANNEL_NAME: {},
  },
});

const { sweepTriggers } = await import("@/lib/workflows/sweep");

const WORKSPACE = "ws-1";
const WORKFLOW = "wf-1";

function githubGraph(watch: Record<string, string>): WorkflowGraph {
  return {
    start: "trigger",
    steps: {
      trigger: {
        type: "app_event_trigger",
        event: "NEW_GITHUB_ISSUE",
        interval_minutes: 60,
        ...watch,
        next: "note",
      },
      note: { type: "log_action", label: "note", message: "ran", next: null },
    },
  };
}

function reset(graph: WorkflowGraph, triggerState: Record<string, unknown> | null = null) {
  calls.length = 0;
  reply = { successful: true, data: { items: [] } };
  db.replace("workflow_runs", []);
  db.replace("credit_ledger", []);
  db.replace("workflows", []);
  db.replace("agent_settings", []);
  db.seed("workflows", {
    id: WORKFLOW,
    workspace_id: WORKSPACE,
    active: true,
    config: { v: 1, graph, display: { groups: [] } },
    trigger_state: triggerState,
  });
  db.seed("agent_settings", { workspace_id: WORKSPACE, timezone: "UTC" });
  db.seed("credit_ledger", { workspace_id: WORKSPACE, delta: 100, reason: "signup_bonus" });
}

const state = () =>
  db.table("workflows")[0].trigger_state as {
    lastError?: string;
    cursor?: string;
    lastCheckedAt?: string;
  };

const sweep = (now: string) =>
  sweepTriggers(db, { now: new Date(now), deadline: Date.now() + 10_000 });

test("a trigger whose target is a placeholder is never polled", async () => {
  // What the builder actually saved when the request never named a repository.
  reset(githubGraph({ watch_owner: "<owner>", watch_repo: "<repo>" }));
  await sweep("2026-08-27T10:00:00Z");

  assert.equal(calls.length, 0, "it asked GitHub for a repository called <repo>");
  assert.match(
    state().lastError ?? "",
    /^Not set up yet/,
    "the header should say what to fill in, not relay a 404",
  );
  assert.ok(state().lastCheckedAt, "it should still record that it looked");
});

test("a real target is polled, with the values the user set", async () => {
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }));
  await sweep("2026-08-27T10:00:00Z");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].slug, "GITHUB_LIST_REPOSITORY_ISSUES");
  assert.equal(calls[0].args.owner, "vercel");
  assert.equal(calls[0].args.repo, "next.js");
  assert.equal(state().lastError, undefined);
});

test("a failed poll does not baseline the cursor", async () => {
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }));
  reply = { successful: false, error: '{"message":"Not Found","status":"404"}' };
  await sweep("2026-08-27T10:00:00Z");

  assert.match(state().lastError ?? "", /Couldn't check for new items/);
  // The defect: falling through with no records baselined the cursor to "",
  // and untilCursor reads a cursor it cannot find as "take the whole page".
  assert.equal(state().cursor, undefined, "a failure must not move the cursor");
  assert.equal(db.table("workflow_runs").length, 0);
});

test("the first poll after a failure baselines instead of replaying the backlog", async () => {
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }));
  reply = { successful: false, error: "404" };
  await sweep("2026-08-27T10:00:00Z");

  // The repo name is fixed; the next poll succeeds and sees issues that were
  // already open. None of them is new, so none of them may fire — this is the
  // ten charged runs and ten real emails the old cursor handling produced.
  reply = {
    successful: true,
    data: { items: [{ id: 3, number: 3 }, { id: 2, number: 2 }, { id: 1, number: 1 }] },
  };
  await sweep("2026-08-27T11:01:00Z");

  assert.equal(db.table("workflow_runs").length, 0, "pre-existing issues fired as if new");
  assert.equal(state().cursor, "3", "it should baseline on the newest record");
  assert.equal(state().lastError, undefined);
});

test("a record that arrives after the baseline fires exactly one run", async () => {
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }));
  reply = { successful: true, data: { items: [{ id: 1, number: 1 }] } };
  await sweep("2026-08-27T10:00:00Z");
  assert.equal(db.table("workflow_runs").length, 0, "the first poll only baselines");

  reply = { successful: true, data: { items: [{ id: 2, number: 2 }, { id: 1, number: 1 }] } };
  await sweep("2026-08-27T11:01:00Z");
  assert.equal(db.table("workflow_runs").length, 1);
  assert.equal(state().cursor, "2");
});

test("an unconfigured trigger forgets the cursor the old failed poll poisoned", async () => {
  /*
   * The production population this whole change is about. Under the old code a
   * placeholder trigger polled, GitHub 404'd, and the fall-through wrote
   * `cursor: ""`. That row is still there — and "" is a cursor `untilCursor`
   * cannot find, which it reads as "the page moved past it" and answers with
   * the WHOLE page. So the first poll after somebody fixed the repo name would
   * have fired a run per pre-existing issue.
   */
  reset(githubGraph({ watch_owner: "<owner>", watch_repo: "<repo>" }), {
    lastCheckedAt: "2026-08-27T09:00:00.000Z",
    cursor: "",
    lastError: "Couldn't check for new items: 404",
  });
  await sweep("2026-08-27T10:01:00Z");
  assert.equal(calls.length, 0);
  assert.equal(state().cursor, undefined, "the poisoned baseline should be dropped");

  // The user fills in the real repository. Twelve issues are already open.
  db.table("workflows")[0].config = {
    v: 1,
    display: { groups: [] },
    graph: githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }),
  };
  reply = {
    successful: true,
    data: { items: Array.from({ length: 12 }, (_, i) => ({ id: 100 - i, number: 100 - i })) },
  };
  await sweep("2026-08-27T11:02:00Z");

  assert.equal(db.table("workflow_runs").length, 0, "pre-existing issues fired as if new");
  assert.equal(state().cursor, "100");
  assert.equal(state().lastError, undefined, "and no phantom backlog warning");
});

test("a big first page baselines quietly instead of promising runs it will never make", async () => {
  // `unseen` is the whole page on a first poll and `fresh` is capped, so the
  // backlog message used to fire — then the baseline branch discarded every one
  // of those records. An orange banner on a brand-new automation, naming ten
  // runs that were never going to happen.
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }));
  reply = {
    successful: true,
    data: { items: Array.from({ length: 20 }, (_, i) => ({ id: 200 - i, number: 200 - i })) },
  };
  await sweep("2026-08-27T10:00:00Z");

  assert.equal(db.table("workflow_runs").length, 0);
  assert.equal(state().cursor, "200");
  assert.equal(state().lastError, undefined);
});

test("a real backlog past the per-poll cap still says so", async () => {
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }), {
    lastCheckedAt: "2026-08-27T09:00:00.000Z",
    cursor: "1",
  });
  reply = {
    successful: true,
    data: { items: Array.from({ length: 15 }, (_, i) => ({ id: 16 - i, number: 16 - i })) },
  };
  await sweep("2026-08-27T10:01:00Z");
  assert.match(state().lastError ?? "", /more waiting — they run on the next check/);
});

test("switching to realtime clears a poll error nothing else can", async () => {
  // realtime.ts's write spreads the old state and the push route never touches
  // trigger_state, so this is the only place that error can ever be retired.
  reset(githubGraph({ watch_owner: "vercel", watch_repo: "next.js" }), {
    lastCheckedAt: "2026-08-27T09:00:00.000Z",
    lastError: "Couldn't check for new items: 404",
    realtime: { mode: "realtime", instanceId: "ti_123", at: "2026-08-27T09:00:00.000Z" },
  });
  await sweep("2026-08-27T10:01:00Z");
  assert.equal(calls.length, 0, "a workflow Composio watches must not also be polled");
  assert.equal(state().lastError, undefined);
});
