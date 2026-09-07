import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

// No FIRECRAWL_API_KEY: web research is a server-owned capability, so an
// install without the key must refuse every call in one recognisable way
// rather than reaching the provider unauthenticated.
process.env.FIRECRAWL_API_KEY = "";

mock.module("@/lib/net/public-url", {
  namedExports: {
    assertPublicUrl: async (url: string) => (url.startsWith("https://") ? new URL(url).toString() : null),
  },
});

const { runFirecrawl, FirecrawlError } = await import("@/lib/integrations/firecrawl");

test("an install with no server key fails with missing_credential and never calls the provider", async () => {
  let called = false;
  await assert.rejects(
    runFirecrawl(
      { operation: "scrape", url: "https://example.com" },
      {
        workspaceId: "ws-1",
        fetcher: async () => {
          called = true;
          return new Response("{}", { headers: { "content-type": "application/json" } });
        },
      },
    ),
    (err: unknown) => err instanceof FirecrawlError && err.code === "missing_credential",
  );
  assert.equal(called, false);
});
