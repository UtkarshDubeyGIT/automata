import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

let providerResult: unknown = {
  kind: "result",
  operation: "search",
  status: "completed",
  text: "result text",
  data: { web: [{ url: "https://example.com" }] },
  sources: ["https://example.com"],
};
const calls: Record<string, unknown>[] = [];

mock.module("@/lib/integrations/firecrawl", {
  namedExports: {
    runFirecrawl: async (request: Record<string, unknown>, context: Record<string, unknown>) => {
      calls.push({ request, context });
      return providerResult;
    },
  },
});

const { HANDLERS, Await } = await import("@/lib/workflows/steps");
const { NODE_TYPES, outputKeys } = await import("@/lib/workflows/blocks");
const { missingSetup, validateGraph } = await import("@/lib/workflows/validate");
const { requiredAppsOf } = await import("@/lib/workflows/apps");

function ctx(step: Record<string, unknown>, awaiting?: Record<string, unknown>) {
  return {
    runId: "run-1",
    stepId: "research",
    step: { type: "firecrawl", ...step },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
    awaiting,
  } as never;
}

test("the catalog exposes a native Firecrawl node with stable output references", () => {
  assert.equal(NODE_TYPES.firecrawl.label, "Firecrawl research");
  assert.deepEqual(outputKeys({ type: "firecrawl" }), new Set(["text", "data", "sources", "operation", "jobId", "status"]));
  assert.deepEqual(requiredAppsOf({ start: "start", steps: { start: { type: "manual_trigger_input" }, research: { type: "firecrawl" } } }), [
    { app: "firecrawl", label: "Firecrawl", simulated: false },
  ]);
});

test("Firecrawl workflow setup requires an operation-specific input", () => {
  assert.deepEqual(missingSetup({ type: "firecrawl", operation: "search" }), ["Enter a search query"]);
  assert.deepEqual(missingSetup({ type: "firecrawl", operation: "scrape" }), ["Enter a public URL"]);
  assert.deepEqual(missingSetup({ type: "firecrawl", operation: "agent" }), ["Enter a public URL", "Describe what to extract"]);
});

test("Firecrawl workflow graphs cannot persist credential-shaped fields", () => {
  assert.throws(
    () => validateGraph({
      start: "start",
      steps: {
        start: { type: "manual_trigger_input", next: "research" },
        research: {
          type: "firecrawl",
          operation: "scrape",
          url: "https://example.com",
          apiKey: "fc-secret",
        },
      },
    }),
    /credentials are managed by the workspace integration/,
  );
});

test("a synchronous Firecrawl read returns source-carrying workflow output", async () => {
  calls.length = 0;
  providerResult = {
    kind: "result",
    operation: "search",
    status: "completed",
    text: "result text",
    data: { web: [{ url: "https://example.com" }] },
    sources: ["https://example.com"],
  };
  const out = await HANDLERS.firecrawl(ctx({ operation: "search", query: "zidane" }));
  assert.deepEqual(out, {
    operation: "search",
    status: "completed",
    text: "result text",
    data: { web: [{ url: "https://example.com" }] },
    sources: ["https://example.com"],
  });
  assert.equal((calls[0].context as { workspaceId: string }).workspaceId, "ws-1");
});

test("crawl parks once and resumes by polling the existing job", async () => {
  calls.length = 0;
  providerResult = { kind: "job", operation: "crawl", jobId: "crawl-1", status: "queued", sources: ["https://example.com"] };
  await assert.rejects(
    HANDLERS.firecrawl(ctx({ operation: "crawl", url: "https://example.com" })),
    (error: unknown) => error instanceof Await && error.kind === "firecrawl" && error.ref === "crawl-1",
  );

  providerResult = {
    kind: "result",
    operation: "crawl",
    status: "completed",
    jobId: "crawl-1",
    text: "crawled",
    sources: ["https://example.com/about"],
  };
  const out = await HANDLERS.firecrawl(ctx(
    { operation: "crawl", url: "https://example.com" },
    { kind: "firecrawl", stepId: "research", ref: "crawl-1", note: "Waiting", since: new Date().toISOString() },
  ));
  assert.equal(out.jobId, "crawl-1");
  assert.deepEqual(calls.map((call) => call.request), [
    { operation: "crawl", url: "https://example.com" },
    { operation: "crawl", jobId: "crawl-1" },
  ]);
});
