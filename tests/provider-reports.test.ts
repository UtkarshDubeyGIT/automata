import { strict as assert } from "node:assert";
import { test } from "node:test";
import { normalizePerformanceRows } from "@/lib/google/business-profile";
import {
  googleAdsCustomerId,
  googleAdsQuery,
  normalizeGoogleAdsRows,
} from "@/lib/google/ads";
import { TOOLS } from "@/lib/workflows/registry";

test("Google Ads customer ids are normalized and invalid ids are rejected", () => {
  assert.equal(googleAdsCustomerId("123-456-7890"), "1234567890");
  assert.equal(googleAdsCustomerId("1234567890"), "1234567890");
  assert.throws(() => googleAdsCustomerId("123"), /customer id/i);
});

test("Google Ads report queries are allowlisted and period-bounded", () => {
  const query = googleAdsQuery({
    startDate: "2026-08-22",
    endDate: "2026-09-20",
    resource: "customer",
  });
  assert.match(query, /FROM customer/);
  assert.match(query, /segments\.date/);
  assert.match(query, /2026-08-22/);
  assert.throws(
    () => googleAdsQuery({ startDate: "2026-08-22", endDate: "2026-09-20", resource: "campaign" }),
    /resource/i,
  );
  assert.throws(
    () => googleAdsQuery({ startDate: "2026-08-22", endDate: "2026-09-20", resource: "users" }),
    /resource/i,
  );
});

test("Google Ads rows normalize cost micros and preserve daily dimensions", () => {
  const rows = normalizeGoogleAdsRows([
    {
      campaign: { id: "7", name: "Launch" },
      segments: { date: "2026-09-20" },
      metrics: { costMicros: "1250000", impressions: "100", clicks: "5" },
    },
  ]);
  assert.deepEqual(rows, [
    { date: "2026-09-20", campaignId: "7", campaignName: "Launch", spend: 1.25, impressions: 100, clicks: 5 },
  ]);
});

test("GBP performance series are normalized without manufacturing missing metrics", () => {
  const rows = normalizePerformanceRows([
    {
      dailyMetric: "WEBSITE_CLICKS",
      timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 20 }, value: "4" }] },
    },
    {
      dailyMetric: "CALL_CLICKS",
      timeSeries: { datedValues: [{ date: { year: 2026, month: 9, day: 20 }, value: "0" }] },
    },
  ]);
  assert.deepEqual(rows, [{ date: "2026-09-20", websiteClicks: 4, calls: 0 }]);
});

test("report actions are read-only and discoverable by the workflow builder", () => {
  assert.equal(TOOLS.GOOGLEBUSINESS_GET_PERFORMANCE_REPORT?.kind, "read");
  assert.equal(TOOLS.GOOGLEADS_GET_REPORT?.kind, "read");
  assert.equal(TOOLS.GOOGLEADS_GET_REPORT?.external, false);
});
