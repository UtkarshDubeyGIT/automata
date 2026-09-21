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

const DATA_API = "https://analyticsdata.googleapis.com/v1beta";
const DEFAULT_DATE_RANGES = [{ startDate: "30daysAgo", endDate: "today" }];
const DEFAULT_DIMENSIONS = ["date"];
const DEFAULT_METRICS = ["activeUsers", "sessions", "screenPageViews"];
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

type JsonRecord = Record<string, unknown>;

interface GaValue {
  value?: string;
}

interface GaRow {
  dimensionValues?: GaValue[];
  metricValues?: GaValue[];
}

interface GaReportResponse {
  dimensionHeaders?: Array<{ name?: string }>;
  metricHeaders?: Array<{ name?: string }>;
  rows?: GaRow[];
  rowCount?: number;
  metadata?: JsonRecord;
  error?: { message?: string };
}

function jsonValue(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} must be valid JSON.`);
  }
}

function objectValue(value: unknown, label: string): JsonRecord | undefined {
  const parsed = jsonValue(value, label);
  if (parsed === undefined) return undefined;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed as JsonRecord;
}

function arrayValue(value: unknown, label: string): unknown[] | undefined {
  const parsed = jsonValue(value, label);
  if (parsed === undefined) return undefined;
  if (!Array.isArray(parsed)) throw new Error(`${label} must be a JSON array.`);
  return parsed;
}

function namedFields(
  value: unknown,
  label: string,
  fallback: string[],
  allowEmpty = false,
): Array<{ name: string }> {
  const entries = arrayValue(value, label) ?? fallback;
  const names = entries.map((entry) => {
    if (typeof entry === "string") return entry.trim();
    if (entry && typeof entry === "object" && typeof (entry as JsonRecord).name === "string") {
      return String((entry as JsonRecord).name).trim();
    }
    return "";
  });
  if ((!allowEmpty && !names.length) || names.some((name) => !name)) {
    throw new Error(`${label} must contain one or more field names.`);
  }
  return names.map((name) => ({ name }));
}

/** Normalize the only two GA4 property forms this product accepts. */
export function ga4Property(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (/^\d+$/.test(value)) return `properties/${value}`;
  if (/^properties\/\d+$/.test(value)) return value;
  throw new Error("GA4 property must be a numeric property ID or properties/<id>.");
}

function reportRequest(args: JsonRecord): JsonRecord {
  const dateRanges = arrayValue(args.date_ranges ?? args.dateRanges, "date_ranges") ?? DEFAULT_DATE_RANGES;
  if (!dateRanges.length || dateRanges.some((range) => !range || typeof range !== "object" || Array.isArray(range))) {
    throw new Error("date_ranges must contain one or more date-range objects.");
  }

  const limitValue = Number(args.limit ?? DEFAULT_LIMIT);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1 || limitValue > MAX_LIMIT) {
    throw new Error(`limit must be a whole number from 1 to ${MAX_LIMIT}.`);
  }

  const request: JsonRecord = {
    dateRanges,
    dimensions: namedFields(args.dimensions, "dimensions", DEFAULT_DIMENSIONS, true),
    metrics: namedFields(args.metrics, "metrics", DEFAULT_METRICS),
    limit: limitValue,
  };

  const optionalObjects: Array<[string, unknown, string]> = [
    ["dimensionFilter", args.dimension_filter ?? args.dimensionFilter, "dimension_filter"],
    ["metricFilter", args.metric_filter ?? args.metricFilter, "metric_filter"],
  ];
  for (const [key, value, label] of optionalObjects) {
    const parsed = objectValue(value, label);
    if (parsed) request[key] = parsed;
  }

  const orderBys = arrayValue(args.order_bys ?? args.orderBys, "order_bys");
  if (orderBys) request.orderBys = orderBys;

  const offset = args.offset;
  if (offset !== undefined && String(offset).trim() !== "") {
    const parsed = Number(offset);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("offset must be a non-negative whole number.");
    request.offset = String(parsed);
  }

  const metricAggregations = arrayValue(args.metric_aggregations ?? args.metricAggregations, "metric_aggregations");
  if (metricAggregations) request.metricAggregations = metricAggregations;

  const currencyCode = args.currency_code ?? args.currencyCode;
  if (currencyCode !== undefined && String(currencyCode).trim() !== "") request.currencyCode = String(currencyCode).trim();

  for (const [key, source] of [
    ["keepEmptyRows", args.keep_empty_rows ?? args.keepEmptyRows],
    ["returnPropertyQuota", args.return_property_quota ?? args.returnPropertyQuota],
  ] as const) {
    if (source === undefined || String(source).trim() === "") continue;
    if (source !== true && source !== false && source !== "true" && source !== "false") {
      throw new Error(`${key} must be true or false.`);
    }
    request[key] = source === true || source === "true";
  }
  return request;
}

function readableRows(response: GaReportResponse): Record<string, string>[] {
  const headers = [
    ...(response.dimensionHeaders ?? []).map((header) => header.name ?? "dimension"),
    ...(response.metricHeaders ?? []).map((header) => header.name ?? "metric"),
  ];
  return (response.rows ?? []).map((row) => {
    const values = [...(row.dimensionValues ?? []), ...(row.metricValues ?? [])];
    return Object.fromEntries(headers.map((header, index) => [header, values[index]?.value ?? ""]));
  });
}

function normalizeRollingRows(rows: Record<string, string>[]): MetricRow[] {
  return rows.map((row) => {
    const date = String(row.date ?? "");
    return /^\d{8}$/.test(date)
      ? { ...row, date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` }
      : row;
  });
}

function providerMessage(response: GaReportResponse): string {
  return response.error?.message?.trim() || "unknown provider error";
}

/** Run a GA4 Data API report without ever handling the workspace OAuth token. */
export async function runGa4Report(workspaceId: string, args: JsonRecord): Promise<JsonRecord> {
  const property = ga4Property(args.property);
  const response = await proxyFor<GaReportResponse>(workspaceId, "google_analytics", {
    endpoint: `${DATA_API}/${property}:runReport`,
    method: "POST",
    parameters: [{ name: "Content-Type", value: "application/json", type: "header" }],
    body: reportRequest(args),
  });
  if (!response) {
    throw new Error("google_analytics is not connected — connect it on the Integrations page, then run again.");
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = providerMessage(response.data ?? {});
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Google Analytics denied the report (${detail}) — reconnect Google Analytics with analytics.readonly access.`);
    }
    if (response.status === 429) throw new Error(`Google Analytics rate limited this report (${detail}). Try again later.`);
    throw new Error(`Google Analytics report failed (${response.status}): ${detail}`);
  }

  const report = response.data ?? {};
  const rows = readableRows(report);
  const text = rows.length
    ? `${rows.length} GA4 row(s) for ${property}:\n${rows.map((row) => `- ${Object.entries(row).map(([key, value]) => `${key}=${value}`).join(", ")}`).join("\n")}`
    : `No GA4 rows returned for ${property}.`;
  return {
    property,
    rows,
    row_count: Number(report.rowCount ?? rows.length),
    metadata: report.metadata ?? {},
    report,
    text,
  };
}

/**
 * Rolling GA4 reports use frozen completed-day dates and consume every offset
 * page before returning a report. The legacy action above intentionally keeps
 * its relative-date defaults for existing saved workflows.
 */
export async function runGa4RollingReport(workspaceId: string, args: JsonRecord): Promise<JsonRecord> {
  const property = ga4Property(args.property);
  const timeZone = reportScheduleTimeZone(args.time_zone);
  const referenceAt = reportReferenceDate(args.reference_at);
  const range = args.start_date && args.end_date
    ? frozenDateRange(args.start_date, args.end_date, timeZone)
    : previousCompleteDateRange(referenceAt, timeZone);
  const limitValue = Math.min(Number(args.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  if (!Number.isSafeInteger(limitValue) || limitValue < 1) throw new Error("limit must be a positive whole number.");
  let complete = false;
  let decodedBytes = 0;
  const started = Date.now();
  const paged = await paginateReport<MetricRow>(async (offset) => {
    if (Date.now() - started > 60_000) throw new Error("GA4 report exceeded the 60 second execution limit.");
    const page = await runGa4Report(workspaceId, {
      ...args,
      property,
      date_ranges: [{ startDate: range.startDate, endDate: range.endDate }],
      limit: limitValue,
      offset,
    });
    decodedBytes += new TextEncoder().encode(JSON.stringify(page.report ?? {})).byteLength;
    if (decodedBytes > 10 * 1024 * 1024) throw new Error("GA4 report exceeded the 10 MB response limit.");
    const pageRows = normalizeRollingRows((page.rows as Record<string, string>[] | undefined) ?? []);
    const totalRows = Number.isFinite(Number(page.row_count)) ? Number(page.row_count) : undefined;
    const hasMore = totalRows !== undefined
      ? offset + pageRows.length < totalRows
      : pageRows.length >= limitValue;
    return { rows: pageRows, totalRows, hasMore };
  }, { pageSize: limitValue, maxRows: 100_000, maxBytes: 10 * 1024 * 1024 });
  complete = paged.complete;
  if (!complete) throw new Error(`Google Analytics report pagination was incomplete (${paged.reason ?? "provider did not finish"}); no report was delivered.`);
  const aggregate = aggregateMetricRows(paged.rows);
  const requestedMetrics = Array.isArray(args.metrics)
    ? args.metrics.map((metric) => typeof metric === "string" ? metric : String((metric as Record<string, unknown>)?.name ?? "")).filter(Boolean)
    : DEFAULT_METRICS;
  const coverage = reportCoverage(paged.rows, range);
  const unavailableMetrics = requestedMetrics.filter((metric) => aggregate.totals[metric] === undefined);
  return {
    provider: "ga4",
    property,
    range,
    rows: aggregate.daily,
    totals: aggregate.totals,
    complete: true,
    generatedAt: new Date().toISOString(),
    sourceTimeZone: timeZone,
    scheduleTimeZone: reportScheduleTimeZone(args.schedule_time_zone),
    units: { activeUsers: "users (period total unavailable without a separate aggregate query)" },
    availability: {
      requestedMetrics,
      unavailableMetrics,
      coverage,
      dailyRowsTruncated: aggregate.dailyRowsTruncated,
    },
    freshness: "GA4 processing may revise recent completed days",
  };
}
