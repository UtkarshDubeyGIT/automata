import assert from "node:assert/strict";
import test from "node:test";
import { NODE_TYPES } from "@/lib/workflows/blocks";
import { TRIGGERS } from "@/lib/workflows/registry";
import {
  actionResource,
  actionResourceEntries,
  resourceValue,
  selectedResourceId,
  triggerResource,
} from "@/lib/workflows/resources";

test("new manual triggers have no field authoring control", () => {
  assert.equal(NODE_TYPES.manual_trigger_input.fields.some((field) => field.key === "fields"), false);
});

test("resource bindings target known provider fields, not arbitrary IDs", () => {
  assert.equal(triggerResource("NEW_SLACK_MESSAGE", "watch_channel")?.kind, "slack_channel");
  assert.equal(triggerResource("NEW_CALENDAR_EVENT", "watch_calendarId")?.kind, "google_calendar");
  assert.equal(triggerResource("NEW_LINEAR_ISSUE", "watch_team_id")?.kind, "linear_team");
  assert.equal(triggerResource("NEW_LINEAR_ISSUE", "watch_project_id")?.kind, "linear_project");
  assert.equal(triggerResource("NEW_GOOGLE_REVIEW", "watch_location")?.kind, "business_location");
  assert.equal(actionResource("GOOGLE_ANALYTICS_RUN_REPORT", "property")?.kind, "ga4_property");
  assert.equal(actionResource("GOOGLEBUSINESS_GET_PERFORMANCE_REPORT", "location")?.kind, "business_location");
  assert.equal(actionResource("GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY", "site_url")?.kind, "search_console_site");
  assert.equal(actionResource("SLACK_FETCH_CONVERSATION_HISTORY", "channel")?.kind, "slack_channel");
  assert.equal(actionResource("GMAIL_SEND_EMAIL", "recipient_email"), undefined);
});

test("LinkedIn analytics arguments receive their required ID form", () => {
  const id = "12345";
  const org = actionResource("LINKEDIN_GET_ORG_PAGE_STATS", "organization")!;
  const stats = actionResource("LINKEDIN_GET_SHARE_STATS", "organizational_entity")!;
  const size = actionResource("LINKEDIN_GET_NETWORK_SIZE", "organization_id")!;
  assert.equal(resourceValue(org, id), "urn:li:organization:12345");
  assert.equal(resourceValue(stats, id), "urn:li:organization:12345");
  assert.equal(resourceValue(size, id), id);
  assert.equal(selectedResourceId(org, "urn:li:organization:12345"), id);
});

test("Calendar list renders one picker for the action's actual argument spelling", () => {
  assert.deepEqual(actionResourceEntries("GOOGLECALENDAR_EVENTS_LIST").map(([key]) => key), ["calendar_id"]);
  assert.deepEqual(actionResourceEntries("GOOGLECALENDAR_EVENTS_LIST", {
    inputSchema: { properties: { calendarId: { type: "string" } } },
  }).map(([key]) => key), ["calendarId"]);
  assert.deepEqual(actionResourceEntries("GOOGLECALENDAR_EVENTS_LIST", undefined, { calendarId: "team@example.com" }).map(([key]) => key), ["calendarId"]);
});

test("Linear team and project selections scope polling", () => {
  const pollArgs = TRIGGERS.NEW_LINEAR_ISSUE.pollArgs;
  assert.ok(pollArgs);
  assert.deepEqual(pollArgs({ team_id: "team-1", project_id: "project-2" }), {
    first: 20, team_id: "team-1", project_id: "project-2",
  });
  assert.deepEqual(pollArgs({}), { first: 20 });
});
