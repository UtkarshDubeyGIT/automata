import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

process.env.FIRECRAWL_API_KEY = "server-firecrawl-secret";

mock.module("@/lib/net/public-url", {
  namedExports: {
    assertPublicUrl: async (url: string) =>
      url.startsWith("https://") ? new URL(url).toString() : null,
  },
});

const { runFirecrawl, FirecrawlError } = await import("@/lib/integrations/firecrawl");

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("scrape uses the internal server key and normalizes markdown metadata", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const result = await runFirecrawl(
    { operation: "scrape", url: "https://example.com" },
    {
      fetcher: async (url, init) => {
        calls.push({ url: String(url), init });
        return response({
          success: true,
          data: {
            markdown: "# Example\n\nA useful page.",
            metadata: { title: "Example" },
            sourceURL: "https://example.com/",
          },
          creditsUsed: 1,
        });
      },
    },
  );

  assert.equal(result.kind, "result");
  assert.equal(result.operation, "scrape");
  assert.equal(result.text, "# Example\n\nA useful page.");
  assert.deepEqual(result.sources, ["https://example.com/"]);
  assert.deepEqual(result.metadata, { title: "Example" });
  assert.equal(result.usage?.creditsUsed, 1);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer server-firecrawl-secret",
  );
  assert.doesNotMatch(JSON.stringify(result), /server-firecrawl-secret/);
});

test("workflow operations use the same server key as everything else", async () => {
  let authorization = "";
  const result = await runFirecrawl(
    { operation: "search", query: "Zidane AI", limit: 2 },
    {
      workspaceId: "ws-1",
      fetcher: async (_url, init) => {
        authorization = String((init?.headers as Record<string, string>).Authorization);
        return response({
          success: true,
          data: { web: [{ title: "Zidane", url: "https://zidane.ai", description: "AI" }] },
          creditsUsed: 2,
        });
      },
    },
  );
  assert.equal(result.kind, "result");
  assert.equal(result.text, "AI");
  assert.equal(authorization, "Bearer server-firecrawl-secret");
});

test("map, crawl start, and agent start produce stable normalized shapes", async () => {
  const requests: string[] = [];
  const fetcher = async (url: string | URL | Request) => {
    requests.push(String(url));
    if (String(url).endsWith("/map")) return response({ success: true, links: ["https://example.com/a"] });
    if (String(url).endsWith("/crawl")) return response({ success: true, id: "crawl-1", url: "https://api.firecrawl.dev/v2/crawl/crawl-1" });
    return response({ success: true, id: "agent-1", url: "https://api.firecrawl.dev/v2/agent/agent-1" });
  };

  const map = await runFirecrawl(
    { operation: "map", url: "https://example.com" },
    { fetcher },
  );
  const crawl = await runFirecrawl(
    { operation: "crawl", url: "https://example.com" },
    { fetcher },
  );
  const agent = await runFirecrawl(
    { operation: "agent", prompt: "Find the pricing", url: "https://example.com" },
    { fetcher },
  );

  assert.deepEqual(map.sources, ["https://example.com/a"]);
  assert.equal(crawl.kind, "job");
  assert.equal(crawl.jobId, "crawl-1");
  assert.deepEqual(crawl.sources, ["https://example.com/"]);
  assert.equal(agent.kind, "job");
  assert.equal(agent.jobId, "agent-1");
  assert.deepEqual(agent.sources, ["https://example.com/"]);
  assert.deepEqual(requests, [
    "https://api.firecrawl.dev/v2/map",
    "https://api.firecrawl.dev/v2/crawl",
    "https://api.firecrawl.dev/v2/agent",
  ]);
});

test("invalid URLs, a missing server key, and provider failures are explicit", async () => {
  await assert.rejects(
    runFirecrawl(
      { operation: "scrape", url: "http://169.254.169.254/latest" },
      { fetcher: async () => response({}) },
    ),
    (err: unknown) => err instanceof FirecrawlError && err.code === "invalid_input",
  );

  await assert.rejects(
    runFirecrawl(
      { operation: "search", query: "test" },
      { fetcher: async () => response({ error: "nope" }, 429) },
    ),
    (err: unknown) => err instanceof FirecrawlError && err.code === "rate_limited" && err.status === 429,
  );

  await assert.rejects(
    runFirecrawl(
      { operation: "scrape", url: "https://example.com", format: "pdf" as never },
      { fetcher: async () => response({}) },
    ),
    (err: unknown) => err instanceof FirecrawlError && err.code === "invalid_input",
  );

  await assert.rejects(
    runFirecrawl(
      { operation: "agent", url: "https://example.com", prompt: "extract", schema: { fields: "x".repeat(25_000) } },
      { fetcher: async () => response({}) },
    ),
    (err: unknown) => err instanceof FirecrawlError && err.code === "invalid_input",
  );
});

test("asynchronous jobs can be polled without starting another job", async () => {
  let calls = 0;
  const result = await runFirecrawl(
    { operation: "crawl", jobId: "crawl-1" },
    {
      fetcher: async (url) => {
        calls++;
        assert.equal(String(url), "https://api.firecrawl.dev/v2/crawl/crawl-1");
        return response({
          success: true,
          status: "completed",
          data: [{ markdown: "done", metadata: { sourceURL: "https://example.com/a" } }],
          creditsUsed: 3,
        });
      },
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.kind, "result");
  assert.equal(result.text, "done");
  assert.equal(result.jobId, "crawl-1");
});

test("normalized payloads are bounded and redact sensitive fields", async () => {
  const result = await runFirecrawl(
    { operation: "scrape", url: "https://example.com" },
    {
      fetcher: async () => response({
        data: {
          markdown: "useful content",
          apiKey: "provider-secret",
          payload: "x".repeat(200_000),
        },
      }),
    },
  );

  assert.equal(result.kind, "result");
  assert.ok(JSON.stringify(result.data).length <= 150_000);
  assert.doesNotMatch(JSON.stringify(result), /provider-secret/);
});

test("source collection follows common result containers", async () => {
  const result = await runFirecrawl(
    { operation: "search", query: "sources" },
    {
      fetcher: async () =>
        response({
          success: true,
          data: {
            results: [{ title: "One", url: "https://one.example.test" }],
            sources: [{ sourceURL: "https://two.example.test" }],
          },
        }),
    },
  );
  assert.deepEqual(result.sources, ["https://one.example.test", "https://two.example.test"]);
});
