import { proxyFor } from "@/lib/social/composio-proxy";
import {
  aggregateMetricRows,
  frozenDateRange,
  previousCompleteDateRange,
  reportCoverage,
  reportReferenceDate,
  reportScheduleTimeZone,
  type MetricRow,
} from "@/lib/analytics/reporting";

export type AnalyticsPeriod = "7d" | "30d" | "90d" | "mtd" | "ytd";

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function metaDateArgs(period: AnalyticsPeriod): Record<string, unknown> {
  const until = new Date();
  switch (period) {
    case "7d":
      return { date_preset: "last_7d" };
    case "30d":
      return { date_preset: "last_30d" };
    case "mtd":
      return { date_preset: "this_month" };
    case "90d":
      return {
        time_range: {
          since: ymd(new Date(until.getTime() - 90 * 86_400_000)),
          until: ymd(until),
        },
      };
    case "ytd":
      return {
        time_range: {
          since: ymd(new Date(Date.UTC(until.getUTCFullYear(), 0, 1))),
          until: ymd(until),
        },
      };
  }
}

export function metaObjectId(adAccountId?: string | null): string {
  const id = (adAccountId ?? "").trim();
  if (!id) return "";
  return id.startsWith("act_") ? id : `act_${id}`;
}

export function normalizeMetaInsightsRows(input: unknown[]): MetricRow[] {
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const date = String(row.date_start ?? row.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const out: MetricRow = { date };
    for (const [source, target] of [
      ["spend", "spend"],
      ["impressions", "impressions"],
      ["clicks", "clicks"],
      ["reach", "reach"],
      ["conversions", "conversions"],
    ] as const) {
      const value = Number(row[source]);
      if (Number.isFinite(value)) out[target] = value;
    }
    return [out];
  });
}

/** Account-level Meta report with a frozen daily window and bounded paging. */
export async function runMetaRollingReport(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const account = metaObjectId(String(args.object_id ?? ""));
  if (!account) throw new Error("A Meta ad account id is required for a rolling report.");
  const timeZone = reportScheduleTimeZone(args.time_zone);
  const referenceAt = reportReferenceDate(args.reference_at);
  const range = args.start_date && args.end_date
    ? frozenDateRange(args.start_date, args.end_date, timeZone)
    : previousCompleteDateRange(referenceAt, timeZone);
  const rows: MetricRow[] = [];
  let after: string | undefined;
  const seen = new Set<string>();
  let complete = false;
  let decodedBytes = 0;
  const started = Date.now();
  for (let page = 0; page < 1000; page++) {
    if (Date.now() - started > 60_000) throw new Error("Meta Ads report exceeded the 60 second execution limit.");
    const response = await proxyFor<Record<string, unknown>>(workspaceId, "metaads", {
      endpoint: `https://graph.facebook.com/v20.0/${account}/insights`,
      method: "GET",
      parameters: [
        { name: "fields", value: "date_start,date_stop,spend,impressions,clicks,reach,conversions", type: "query" },
        { name: "time_range", value: JSON.stringify({ since: range.startDate, until: range.endDate }), type: "query" },
        { name: "time_increment", value: "1", type: "query" },
        { name: "limit", value: "500", type: "query" },
        ...(after ? [{ name: "after", value: after, type: "query" as const }] : []),
      ],
    });
    if (!response) throw new Error("metaads is not connected — connect Meta Ads, then run again.");
    if (response.status < 200 || response.status >= 300) throw new Error(`Meta Ads report failed (${response.status}).`);
    const data = Array.isArray(response.data?.data) ? response.data.data : [];
    decodedBytes += new TextEncoder().encode(JSON.stringify(response.data ?? {})).byteLength;
    if (decodedBytes > 10 * 1024 * 1024) throw new Error("Meta Ads report exceeded the 10 MB response limit.");
    rows.push(...normalizeMetaInsightsRows(data));
    if (rows.length > 100_000) throw new Error("Meta Ads report exceeded the 100,000 row limit.");
    const next = ((response.data?.paging as Record<string, unknown> | undefined)?.cursors as Record<string, unknown> | undefined)?.after;
    if (typeof next !== "string" || !next) {
      complete = true;
      break;
    }
    if (seen.has(next)) throw new Error("Meta Ads provider pagination did not advance.");
    seen.add(next);
    after = next;
  }
  if (!complete) throw new Error("Meta Ads report pagination did not complete.");
  const aggregate = aggregateMetricRows(rows);
  const requestedMetrics = ["spend", "impressions", "clicks", "reach", "conversions"];
  const coverage = reportCoverage(rows, range);
  return {
    provider: "meta_ads",
    account,
    range,
    rows: aggregate.daily,
    totals: aggregate.totals,
    complete: true,
    generatedAt: new Date().toISOString(),
    sourceTimeZone: timeZone,
    scheduleTimeZone: reportScheduleTimeZone(args.schedule_time_zone),
    currency: typeof args.currency === "string" && args.currency.trim() ? args.currency.trim().toUpperCase() : null,
    units: { spend: "account currency", conversions: "provider-defined conversions" },
    availability: {
      requestedMetrics,
      unavailableMetrics: requestedMetrics.filter((metric) => aggregate.totals[metric] === undefined),
      coverage,
      dailyRowsTruncated: aggregate.dailyRowsTruncated,
    },
    freshness: "Meta Ads account response",
  };
}
