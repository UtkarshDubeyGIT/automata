import "server-only";

/** A bounded, provider-neutral row used by rolling reports. */
export type MetricRow = Record<string, unknown> & { date?: string };

export interface DateWindow {
  startDate: string;
  endDate: string;
  days: number;
  timeZone: string;
}

/** Freeze an execution's reference instant when a queued run supplies one. */
export function reportReferenceDate(value: unknown, fallback = new Date()): Date {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error("Report reference time must be a valid ISO timestamp.");
  return parsed;
}

export function reportScheduleTimeZone(value: unknown): string {
  const zone = typeof value === "string" && value.trim() ? value.trim() : "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
  } catch {
    throw new Error(`Invalid reporting timezone '${zone}'`);
  }
  return zone;
}

const ADDITIVE_METRICS = new Set([
  "spend",
  "cost",
  "impressions",
  "clicks",
  "conversions",
  "sessions",
  "screenPageViews",
  "websiteClicks",
  "calls",
  "directions",
]);

const UNIQUE_METRICS = new Set(["reach", "activeUsers", "users", "uniqueUsers"]);

function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date: string, days: number): string {
  const shifted = new Date(`${date}T12:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Return the previous complete calendar days in the provider's timezone.
 *
 * Using the source-local date, rather than subtracting 24-hour milliseconds,
 * keeps the contract correct across daylight-saving transitions and retries
 * that cross midnight.
 */
export function previousCompleteDateRange(
  now: Date,
  timeZone: string,
  days = 30,
): DateWindow {
  if (!Number.isInteger(days) || days < 1 || days > 366) {
    throw new Error("days must be a whole number from 1 to 366");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(now);
  } catch {
    throw new Error(`Invalid reporting timezone '${timeZone}'`);
  }
  const today = localDate(now, timeZone);
  const endDate = shiftDate(today, -1);
  return {
    startDate: shiftDate(endDate, -(days - 1)),
    endDate,
    days,
    timeZone,
  };
}

/** Validate and describe a date window frozen by a scheduled/manual run. */
export function frozenDateRange(startDate: unknown, endDate: unknown, timeZone: string): DateWindow {
  const start = String(startDate ?? "").trim();
  const end = String(endDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error("Report dates must be YYYY-MM-DD.");
  }
  const startMs = Date.parse(`${start}T12:00:00.000Z`);
  const endMs = Date.parse(`${end}T12:00:00.000Z`);
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    new Date(startMs).toISOString().slice(0, 10) !== start ||
    new Date(endMs).toISOString().slice(0, 10) !== end
  ) {
    throw new Error("Report dates must be valid calendar dates.");
  }
  const days = Math.round((endMs - startMs) / 86_400_000) + 1;
  if (!Number.isFinite(days) || days < 1 || days > 366) {
    throw new Error("Report date range must contain between 1 and 366 calendar days.");
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date());
  } catch {
    throw new Error(`Invalid reporting timezone '${timeZone}'`);
  }
  return { startDate: start, endDate: end, days, timeZone };
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface AggregatedMetrics {
  totals: Record<string, number | undefined>;
  daily: MetricRow[];
  /** True when the bounded output had to omit older daily buckets. */
  dailyRowsTruncated: boolean;
}

/** Enumerate the inclusive calendar dates represented by a frozen window. */
export function dateRangeDates(range: Pick<DateWindow, "startDate" | "endDate">): string[] {
  const dates: string[] = [];
  let cursor = range.startDate;
  while (cursor <= range.endDate && dates.length <= 366) {
    dates.push(cursor);
    cursor = shiftDate(cursor, 1);
  }
  return dates;
}

/** Explain date coverage without turning an absent provider value into zero. */
export function reportCoverage(rows: MetricRow[], range: DateWindow): {
  expectedDays: number;
  returnedDays: number;
  missingDates: string[];
} {
  const returned = new Set(
    rows
      .map((row) => (typeof row.date === "string" ? row.date : ""))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)),
  );
  const missingDates = dateRangeDates(range).filter((date) => !returned.has(date));
  return { expectedDays: range.days, returnedDays: returned.size, missingDates };
}

/**
 * Aggregate only metrics that are safe to add. Ratios are recomputed from
 * their numerators/denominators and unique users/reach stay daily-only until
 * a provider supplies a separately aggregated period value.
 */
export function aggregateMetricRows(rows: MetricRow[]): AggregatedMetrics {
  const totals: Record<string, number | undefined> = {};
  for (const metric of ADDITIVE_METRICS) {
    const values = rows.map((row) => numberValue(row[metric])).filter((value): value is number => value !== undefined);
    if (values.length) totals[metric] = values.reduce((sum, value) => sum + value, 0);
  }
  // Preserve the distinction explicitly: undefined means unavailable, not 0.
  for (const metric of UNIQUE_METRICS) totals[metric] = undefined;

  const clicks = totals.clicks;
  const impressions = totals.impressions;
  if (clicks !== undefined && impressions !== undefined && impressions > 0) {
    totals.ctr = (clicks / impressions) * 100;
  }
  const spend = totals.spend ?? totals.cost;
  if (spend !== undefined && clicks !== undefined && clicks > 0) totals.cpc = spend / clicks;
  if (spend !== undefined && impressions !== undefined && impressions > 0) {
    totals.cpm = (spend / impressions) * 1000;
  }

  // Providers can return one row per campaign/metric while the v1 contract is
  // account/location totals. Collapse dated rows before bounding the output so
  // a breakdown cannot evict half of the requested calendar window. Totals are
  // still computed from every raw row above.
  const byDate = new Map<string, MetricRow>();
  const undated: MetricRow[] = [];
  for (const row of rows) {
    const date = typeof row.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : "";
    if (!date) {
      undated.push(row);
      continue;
    }
    const current = byDate.get(date) ?? { date };
    for (const metric of ADDITIVE_METRICS) {
      const value = numberValue(row[metric]);
      if (value !== undefined) current[metric] = (numberValue(current[metric]) ?? 0) + value;
    }
    byDate.set(date, current);
  }
  const daily = [...byDate.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const allDaily = [...daily, ...undated];
  return {
    totals,
    daily: allDaily.slice(-30),
    dailyRowsTruncated: allDaily.length > 30,
  };
}

export interface PageResult<T extends MetricRow> {
  rows: T[];
  /** Provider-reported total row count, when available. */
  totalRows?: number;
  /** Cursor-based providers can state whether another page exists. */
  hasMore?: boolean;
}

export interface PaginationResult<T extends MetricRow> {
  rows: T[];
  complete: boolean;
  reason?: string;
}

/**
 * Consume a provider's offset pages with explicit row and decoded-byte caps.
 * A repeated page is treated as incomplete instead of looping or delivering a
 * deceptively partial report.
 */
export async function paginateReport<T extends MetricRow>(
  fetchPage: (offset: number) => Promise<PageResult<T>>,
  limits: { pageSize: number; maxRows: number; maxBytes: number },
): Promise<PaginationResult<T>> {
  if (!Number.isInteger(limits.pageSize) || limits.pageSize < 1) throw new Error("pageSize must be positive");
  const rows: T[] = [];
  const seenPages = new Set<string>();
  let offset = 0;
  let totalRows: number | undefined;
  let bytes = 0;

  while (true) {
    if (rows.length >= limits.maxRows) return { rows, complete: false, reason: "report row limit exceeded" };
    const page = await fetchPage(offset);
    totalRows = page.totalRows ?? totalRows;
    const encoded = JSON.stringify(page.rows);
    bytes += new TextEncoder().encode(encoded).byteLength;
    if (bytes > limits.maxBytes) return { rows, complete: false, reason: "report response size limit exceeded" };
    const pageKey = `${offset}:${encoded}`;
    if (seenPages.has(pageKey) || (page.rows.length > 0 && [...seenPages].some((key) => key.endsWith(`:${encoded}`)))) {
      return { rows, complete: false, reason: "provider page did not advance" };
    }
    seenPages.add(pageKey);
    rows.push(...page.rows);
    if (rows.length > limits.maxRows) return { rows: rows.slice(0, limits.maxRows), complete: false, reason: "report row limit exceeded" };
    if (!page.rows.length) {
      if (page.hasMore === true) return { rows, complete: false, reason: "provider page advanced without rows" };
      return { rows, complete: totalRows === undefined || rows.length >= totalRows };
    }
    if (page.hasMore === false) return { rows, complete: true };
    if (page.hasMore === true) {
      offset += page.rows.length;
      continue;
    }
    if (totalRows !== undefined && rows.length >= totalRows) return { rows, complete: true };
    if (page.rows.length < limits.pageSize && totalRows === undefined) return { rows, complete: true };
    offset += page.rows.length;
  }
}
