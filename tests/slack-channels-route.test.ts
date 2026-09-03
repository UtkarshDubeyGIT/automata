import assert from "node:assert/strict";
import { mock, test } from "node:test";

let entityId: string | null = null;
let calls = 0;

mock.module("@/lib/workspace", {
  namedExports: {
    resolveRequestContext: async () => ({ entityId }),
  },
});

mock.module("@/lib/social/composio", {
  namedExports: {
    slackChannels: async (requestedEntityId: string) => {
      calls += 1;
      return [{ id: "C123", name: requestedEntityId, private: false }];
    },
  },
});

const { GET } = await import("@/app/api/integrations/slack/channels/route");

test("Slack channels require a resolved entity identity", async () => {
  entityId = null;
  const response = await GET();

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Sign in to list Slack channels." });
  assert.equal(calls, 0);
});

test("Slack channels are fetched and cached per entity", async () => {
  entityId = "workspace-1";
  const first = await GET();
  const second = await GET();

  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), {
    channels: [{ id: "C123", name: "workspace-1", private: false }],
  });
  assert.deepEqual(await second.json(), {
    channels: [{ id: "C123", name: "workspace-1", private: false }],
  });
  assert.equal(calls, 1);
});
