import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  aggregateMetricRows,
  frozenDateRange,
  previousCompleteDateRange,
  paginateReport,
  type MetricRow,
} from "@/lib/analytics/reporting";

test("previous complete date range is exactly 30 inclusive source-local days", () => {
  const range = previousCompleteDateRange(
    new Date("2026-09-21T00:15:00.000Z"),
    "Asia/Kolkata",
  );
  assert.deepEqual(range, {
    startDate: "2026-08-22",
    endDate: "2026-09-20",
    days: 30,
    timeZone: "Asia/Kolkata",
  });
});

test("date windows use calendar days across daylight-saving changes", () => {
  const range = previousCompleteDateRange(
    new Date("2026-11-02T15:00:00.000Z"),
    "America/New_York",
  );
  assert.deepEqual(range, {
    startDate: "2026-10-03",
    endDate: "2026-11-01",
    days: 30,
    timeZone: "America/New_York",
  });
});

test("explicit report windows are validated and carry inclusive day counts", () => {
  assert.deepEqual(frozenDateRange("2026-08-22", "2026-09-20", "UTC"), {
    startDate: "2026-08-22",
    endDate: "2026-09-20",
    days: 30,
    timeZone: "UTC",
  });
  assert.throws(() => frozenDateRange("2026-09-20", "2026-08-22", "UTC"), /range/i);
});

test("period totals sum additive metrics and weight ratios without summing uniques", () => {
  const rows: MetricRow[] = [
    { date: "2026-09-01", spend: 10, impressions: 100, clicks: 5, reach: 90, activeUsers: 80 },
    { date: "2026-09-02", spend: 20, impressions: 300, clicks: 15, reach: 100, activeUsers: 100 },
  ];
  const result = aggregateMetricRows(rows);
  assert.equal(result.totals.spend, 30);
  assert.equal(result.totals.impressions, 400);
  assert.equal(result.totals.clicks, 20);
  assert.equal(result.totals.ctr, 5);
  assert.equal(result.totals.reach, undefined);
  assert.equal(result.totals.activeUsers, undefined);
  assert.equal(result.daily.length, 2);
});

test("pagination consumes every page and stops at the row and byte bounds", async () => {
  const calls: number[] = [];
  const rows = await paginateReport(
    async (offset) => {
      calls.push(offset);
      return offset === 0
        ? { rows: [{ date: "2026-09-01", clicks: 1 }], totalRows: 2 }
        : { rows: [{ date: "2026-09-02", clicks: 2 }], totalRows: 2 };
    },
    { pageSize: 1, maxRows: 2, maxBytes: 10_000 },
  );
  assert.deepEqual(calls, [0, 1]);
  assert.equal(rows.complete, true);
  assert.equal(rows.rows.length, 2);
});

test("pagination reports an incomplete result when a provider page repeats", async () => {
  const result = await paginateReport(
    async () => ({ rows: [{ date: "2026-09-01", clicks: 1 }], totalRows: 3 }),
    { pageSize: 1, maxRows: 10, maxBytes: 10_000 },
  );
  assert.equal(result.complete, false);
  assert.match(result.reason ?? "", /did not advance/i);
});
