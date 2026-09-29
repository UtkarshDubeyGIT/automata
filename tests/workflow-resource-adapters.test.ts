import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResourceChoices, pickerStatus } from "@/lib/workflows/resource-options";

test("GA4 account summaries become named property choices", () => {
  assert.deepEqual(normalizeResourceChoices("ga4_property", {
    accountSummaries: [{ displayName: "Northwind", propertySummaries: [
      { property: "properties/123", displayName: "Store" },
      { property: "properties/456", displayName: "Blog" },
    ] }],
  }), [
    { value: "properties/123", label: "Store", secondary: "Northwind" },
    { value: "properties/456", label: "Blog", secondary: "Northwind" },
  ]);
});

test("provider resources keep exact runtime values", () => {
  assert.deepEqual(normalizeResourceChoices("google_calendar", {
    items: [{ id: "team@example.com", summary: "Team", primary: false }],
  }), [{ value: "team@example.com", label: "Team" }]);
  assert.deepEqual(normalizeResourceChoices("business_location", {
    locations: [{ name: "locations/77", title: "Main Street" }],
  }), [{ value: "locations/77", label: "Main Street" }]);
  assert.deepEqual(normalizeResourceChoices("search_console_site", {
    siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" }],
  }), [{ value: "sc-domain:example.com", label: "sc-domain:example.com" }]);
});

test("Linear GraphQL errors are not mistaken for an empty resource list", () => {
  assert.throws(() => normalizeResourceChoices("linear_team", {
    errors: [{ message: "Forbidden" }], data: { teams: { nodes: [] } },
  }), /Forbidden/);
  assert.deepEqual(normalizeResourceChoices("linear_project", {
    data: { projects: { nodes: [{ id: "p1", name: "Launch" }] } },
  }), [{ value: "p1", label: "Launch" }]);
});

test("picker states distinguish loading, disconnected, failure, empty, and stale selections", () => {
  const base = { loading: false, error: "", disconnected: false, choices: [], selected: "", nextCursor: null };
  assert.equal(pickerStatus({ ...base, loading: true }), "loading");
  assert.equal(pickerStatus({ ...base, error: "Connect Slack", disconnected: true }), "disconnected");
  assert.equal(pickerStatus({ ...base, error: "Provider failed" }), "failed");
  assert.equal(pickerStatus(base), "empty");
  assert.equal(pickerStatus({ ...base, selected: "C1", choices: [{ value: "C2", label: "#other" }] }), "stale");
  assert.equal(pickerStatus({ ...base, selected: "C1", choices: [{ value: "C2", label: "#other" }], nextCursor: "page-2" }), "ready");
  assert.equal(pickerStatus({ ...base, selected: "C1", choices: [{ value: "C1", label: "#general" }] }), "ready");
});
