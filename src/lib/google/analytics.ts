import "server-only";

import { proxyFor } from "@/lib/social/composio-proxy";

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
