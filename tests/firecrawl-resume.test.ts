import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => db,
    createClient: async () => db,
  },
});

let pollStatus: "queued" | "completed" = "queued";
mock.module("@/lib/integrations/firecrawl", {
  namedExports: {
    pollFirecrawlJob: async () =>
      pollStatus === "completed"
        ? { kind: "result", operation: "crawl", status: "completed", text: "crawled", sources: ["https://example.com"] }
        : { kind: "job", operation: "crawl", jobId: "crawl-1", status: "scraping", sources: ["https://example.com"] },
    runFirecrawl: async () => ({
      kind: "result",
      operation: "crawl",
      status: "completed",
      text: "crawled",
      sources: ["https://example.com"],
    }),
  },
});

const { resumeRenders } = await import("@/lib/workflows/drain");

const graph = {
  start: "start",
  steps: {
    start: { type: "manual_trigger_input", next: "crawl" },
    crawl: { type: "firecrawl", operation: "crawl", url: "https://example.com", next: "done" },
    done: { type: "log_action", message: "{{steps.crawl.text}}", next: null },
  },
} as never;

function reset() {
  db.replace("workflow_runs", []);
  db.replace("workflows", []);
  db.seed("workflows", { id: "wf-1", workspace_id: "ws-1", active: true });
  db.seed("workflow_runs", {
    id: "run-firecrawl",
    workflow_id: "wf-1",
    status: "waiting",
    started_at: new Date().toISOString(),
    claimed_at: null,
    graph,
    log: {
      v: 1,
      journal: [{ stepId: "start", type: "manual_trigger_input", title: "Start", status: "done", output: {}, at: new Date().toISOString() }],
      context: { steps: { start: {} } },
      awaiting: {
        kind: "firecrawl",
        operation: "crawl",
        stepId: "crawl",
        ref: "crawl-1",
        note: "Waiting",
        since: new Date().toISOString(),
      },
    },
  });
}

test("a Firecrawl job still running is left parked without a drive attempt", async () => {
  reset();
  pollStatus = "queued";
  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  assert.equal(out.parked, 1);
  assert.equal(out.rendering, 1);
  assert.equal(out.resumed, 0);
  assert.equal(db.table("workflow_runs")[0].status, "waiting");
});

test("a completed Firecrawl job resumes through the normal engine", async () => {
  reset();
  pollStatus = "completed";
  const out = await resumeRenders(db, { deadline: Date.now() + 10_000 });
  assert.equal(out.resumed, 1);
  assert.equal(db.table("workflow_runs")[0].status, "completed");
});
