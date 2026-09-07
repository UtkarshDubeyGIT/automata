import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.COMPOSIO_API_KEY = "test-composio-key";

interface ExecuteBody {
  arguments?: Record<string, unknown>;
}

const originalFetch = globalThis.fetch;
// Collected into an array rather than a reassigned `let`: TypeScript keeps a
// `let x: T | null = null` narrowed to `null` when the only writes happen
// inside this callback, so the assertion below could not see the captured
// body at all. `.at()` already yields `T | undefined`, so no cast is needed.
const requests: ExecuteBody[] = [];

globalThis.fetch = async (_input, init) => {
  requests.push(JSON.parse(String(init?.body ?? "{}")) as ExecuteBody);
  return new Response(JSON.stringify({ successful: true, data: { ts: "1710000000.000001" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

const { socialProvider } = await import("@/lib/social/composio");

test("Slack posts use Composio's current markdown message field", async () => {
  requests.length = 0;
  const result = await socialProvider.post({
    entityId: "ws-1",
    platform: "slack",
    text: "*Action items*\n• Priya owns the release notes by Friday.",
    options: { channel: "#growth" },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requests.at(-1)?.arguments, {
    channel: "#growth",
    markdown_text: "*Action items*\n• Priya owns the release notes by Friday.",
  });
});

test.after(() => {
  globalThis.fetch = originalFetch;
});
