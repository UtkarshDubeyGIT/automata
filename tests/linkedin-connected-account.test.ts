import { strict as assert } from "node:assert";
import { test } from "node:test";
import { linkedinConnectedAccountId } from "@/lib/social/linkedin-document";

test("LinkedIn media selects an active connected account scoped to the workspace", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({
      items: [
        {
          id: "ca_own",
          status: "ACTIVE",
          toolkit: { slug: "linkedin" },
          state: { val: { access_token: "REDACTED" } },
        },
      ],
    }));
  }) as typeof fetch;

  try {
    const accountId = await linkedinConnectedAccountId("workspace-123", globalThis.fetch);
    assert.equal(accountId, "ca_own");
    assert.match(requestedUrl, /user_ids=workspace-123/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
