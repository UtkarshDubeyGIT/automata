import assert from "node:assert/strict";
import { mock, test } from "node:test";

const requests: Array<{ workspace: string; toolkit: string; endpoint: string }> = [];
mock.module("@/lib/env", { namedExports: { composioConfigured: true, env: { linkedinApiVersion: "202509" } } });
mock.module("@/lib/social/composio-proxy", { namedExports: {
  connectedAccountIds: async () => ["one"],
  proxyFor: async (workspace: string, toolkit: string, request: { endpoint: string }) => {
    requests.push({ workspace, toolkit, endpoint: request.endpoint });
    return { status: 200, data: {
      items: [{ id: "team@example.com", summary: "Team" }],
      nextPageToken: "next-page",
    } };
  },
} });
mock.module("@/lib/social/composio", { namedExports: {
  linkedinCompanyPages: async () => [], slackChannelPage: async () => ({ channels: [], nextCursor: null }),
} });
mock.module("@/lib/google/business-profile", { namedExports: { businessLocations: async () => [] } });

const { listResourcePage } = await import("@/lib/workflows/resource-server");

test("calendar resource pagination passes the provider cursor and scopes the request", async () => {
  requests.length = 0;
  const page = await listResourcePage("workspace-1", "google_calendar", "cursor-1");
  assert.deepEqual(page.choices, [{ value: "team@example.com", label: "Team" }]);
  assert.equal(page.nextCursor, "next-page");
  assert.equal(requests[0].workspace, "workspace-1");
  assert.equal(requests[0].toolkit, "googlecalendar");
  assert.equal(new URL(requests[0].endpoint).searchParams.get("pageToken"), "cursor-1");
});
