import "server-only";

import { proxyFor } from "@/lib/social/composio-proxy";
import {
  aggregateMetricRows,
  frozenDateRange,
  paginateReport,
  previousCompleteDateRange,
  reportCoverage,
  reportReferenceDate,
  reportScheduleTimeZone,
  type MetricRow,
} from "@/lib/analytics/reporting";

const GOOGLE_ADS_API = "https://googleads.googleapis.com/v20";
const MAX_ROWS = 100_000;
const MAX_BYTES = 10 * 1024 * 1024;

export function googleAdsCustomerId(raw: unknown): string {
  const value = String(raw ?? "").replace(/\s/g, "").replace(/-/g, "");
  if (!/^\d{10}$/.test(value)) throw new Error("Google Ads customer id must contain exactly 10 digits.");
  return value;
}

export type GoogleAdsResource = "customer";

export function googleAdsQuery(input: {
  startDate: string;
  endDate: string;
  resource?: string;
}): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    throw new Error("Google Ads dates must be YYYY-MM-DD.");
  }
  if (input.startDate > input.endDate) throw new Error("Google Ads start date must not follow end date.");
  const resource = input.resource ?? "customer";
  if (resource === "customer") {
    return [
      "SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions",
      "FROM customer",
      `WHERE segments.date BETWEEN '${input.startDate}' AND '${input.endDate}'`,
      "ORDER BY segments.date",
    ].join(" ");
  }
  throw new Error(`Google Ads report resource '${resource}' is not supported.`);
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function normalizeGoogleAdsRows(input: unknown[]): MetricRow[] {
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const campaign = (row.campaign ?? {}) as Record<string, unknown>;
    const segments = (row.segments ?? {}) as Record<string, unknown>;
    const metrics = (row.metrics ?? {}) as Record<string, unknown>;
    const date = typeof segments.date === "string" ? segments.date : undefined;
    if (!date) return [];
    const costMicros = number(metrics.costMicros ?? metrics.cost_micros);
    const result: MetricRow = { date };
    if (campaign.id != null) result.campaignId = String(campaign.id);
    if (campaign.name != null) result.campaignName = String(campaign.name);
    if (costMicros !== undefined) result.spend = costMicros / 1_000_000;
    for (const [from, to] of [["impressions", "impressions"], ["clicks", "clicks"], ["conversions", "conversions"]] as const) {
      const value = number(metrics[from]);
      if (value !== undefined) result[to] = value;
    }
    return [result];
  });
}

interface GoogleAdsResponse {
  results?: unknown[];
  nextPageToken?: string;
  totalResultsCount?: string;
  error?: { message?: string };
}

export async function runGoogleAdsReport(
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const customerId = googleAdsCustomerId(args.customer_id ?? args.customerId);
  const timeZone = reportScheduleTimeZone(args.time_zone);
  const referenceAt = reportReferenceDate(args.reference_at);
  const range = args.start_date && args.end_date
    ? frozenDateRange(args.start_date, args.end_date, timeZone)
    : previousCompleteDateRange(referenceAt, timeZone);
  const query = googleAdsQuery({
    startDate: range.startDate,
    endDate: range.endDate,
    resource: (String(args.resource ?? "customer") as GoogleAdsResource),
  });
  let pageToken: string | undefined;
  let decodedBytes = 0;
  const started = Date.now();
  const paged = await paginateReport<MetricRow>(async () => {
    if (Date.now() - started > 60_000) throw new Error("Google Ads report exceeded the 60 second execution limit.");
    const response = await proxyFor<GoogleAdsResponse>(workspaceId, "googleads", {
      endpoint: `${GOOGLE_ADS_API}/customers/${customerId}/googleAds:search`,
      method: "POST",
      parameters: [{ name: "Content-Type", value: "application/json", type: "header" }],
      body: {
        query,
        pageSize: 10_000,
        ...(pageToken ? { pageToken } : {}),
      },
    });
    if (!response) throw new Error("googleads is not connected — connect Google Ads, then run again.");
    if (response.status < 200 || response.status >= 300) {
      const detail = response.data?.error?.message ?? "unknown provider error";
      throw new Error(`Google Ads report failed (${response.status}): ${detail}`);
    }
    const data = response.data ?? {};
    const pageRows = normalizeGoogleAdsRows(data.results ?? []);
    decodedBytes += new TextEncoder().encode(JSON.stringify(data)).byteLength;
    if (decodedBytes > MAX_BYTES) throw new Error("Google Ads report exceeded the 10 MB response limit.");
    const next = data.nextPageToken?.trim();
    const totalRows = Number.isFinite(Number(data.totalResultsCount)) ? Number(data.totalResultsCount) : undefined;
    if (!next) pageToken = undefined;
    else pageToken = next;
    return { rows: pageRows, totalRows, hasMore: Boolean(next) };
  }, { pageSize: 10_000, maxRows: MAX_ROWS, maxBytes: MAX_BYTES });
  if (!paged.complete) throw new Error(`Google Ads report pagination was incomplete (${paged.reason ?? "provider did not finish"}); no report was delivered.`);
  const rows = paged.rows;
  const aggregate = aggregateMetricRows(rows);
  const requestedMetrics = ["spend", "impressions", "clicks", "conversions"];
  const coverage = reportCoverage(rows, range);
  const unavailableMetrics = requestedMetrics.filter((metric) => aggregate.totals[metric] === undefined);
  return {
    provider: "google_ads",
    customer_id: customerId,
    range: { startDate: range.startDate, endDate: range.endDate, timeZone },
    rows: aggregate.daily,
    totals: aggregate.totals,
    complete: true,
    generatedAt: new Date().toISOString(),
    sourceTimeZone: timeZone,
    scheduleTimeZone: reportScheduleTimeZone(args.schedule_time_zone),
    currency: typeof args.currency_code === "string" && args.currency_code.trim() ? args.currency_code.trim().toUpperCase() : null,
    units: { spend: "account currency", conversions: "provider-defined conversions" },
    availability: {
      requestedMetrics,
      unavailableMetrics,
      coverage,
      dailyRowsTruncated: aggregate.dailyRowsTruncated,
    },
    freshness: "provider response",
  };
}
