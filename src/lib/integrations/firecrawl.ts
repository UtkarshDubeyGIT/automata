import { env } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";
import { assertPublicUrl } from "@/lib/net/public-url";

export type FirecrawlOperation = "scrape" | "search" | "map" | "crawl" | "agent";

export interface FirecrawlRequest {
  operation: FirecrawlOperation;
  url?: string;
  urls?: string[];
  query?: string;
  prompt?: string;
  schema?: Record<string, unknown>;
  limit?: number;
  jobId?: string;
  format?: "markdown" | "html";
  onlyMainContent?: boolean;
}

export interface FirecrawlUsage {
  creditsUsed?: number;
  durationMs?: number;
}

export interface FirecrawlResult {
  kind: "result";
  operation: FirecrawlOperation;
  status: "completed";
  text?: string;
  data?: unknown;
  sources: string[];
  metadata?: Record<string, unknown>;
  jobId?: string;
  usage?: FirecrawlUsage;
}

export interface FirecrawlJob {
  kind: "job";
  operation: "crawl" | "agent";
  jobId: string;
  status: "queued" | "scraping" | "processing";
  sources: string[];
  usage?: FirecrawlUsage;
}

/**
 * Firecrawl runs on ONE server-owned key (`FIRECRAWL_API_KEY`). There is no
 * per-workspace key: every caller — onboarding research, the agent, workflow
 * steps — bills the same account, so `workspaceId` is carried only for
 * logging/quota context and never selects a credential.
 */
export interface FirecrawlContext {
  workspaceId?: string | null;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export type FirecrawlErrorCode =
  | "invalid_input"
  | "missing_credential"
  | "unauthorized"
  | "payment_required"
  | "timeout"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_error";

export class FirecrawlError extends Error {
  readonly name = "FirecrawlError";
  readonly code: FirecrawlErrorCode;
  readonly status?: number;
  readonly retryable: boolean;
  constructor(
    code: FirecrawlErrorCode,
    message: string,
    status?: number,
    retryable = false,
  ) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_TEXT_CHARS = 50_000;
const MAX_DATA_BYTES = 150_000;
const MAX_SOURCES = 100;

/** Run one bounded read-only Firecrawl operation, or start a durable job. */
export async function runFirecrawl(
  request: FirecrawlRequest,
  context: FirecrawlContext = {},
): Promise<FirecrawlResult | FirecrawlJob> {
  const startedAt = Date.now();
  const input = await validateRequest(request);
  const apiKey = credentialFor();
  const fetcher = context.fetcher ?? fetch;

  if ((input.operation === "crawl" || input.operation === "agent") && input.jobId) {
    const path = `${BASE_URL}/v2/${input.operation}/${encodeURIComponent(input.jobId)}`;
    const payload = await requestJson(fetcher, path, apiKey, "GET", undefined, context.timeoutMs);
    return normalizeJobResponse(input.operation, input.jobId, payload, Date.now() - startedAt);
  }

  const { path, body, method } = operationRequest(input);
  const payload = await requestJson(fetcher, `${BASE_URL}${path}`, apiKey, method, body, context.timeoutMs);

  if (input.operation === "crawl" || input.operation === "agent") {
    const jobId = stringValue(payload.id) || extractJobId(stringValue(payload.url));
    if (!jobId) throw new FirecrawlError("provider_error", `Firecrawl ${input.operation} did not return a job id.`);
    return {
      kind: "job",
      operation: input.operation,
      jobId,
      status: "queued",
      sources: input.urls ?? (input.url ? [input.url] : []),
      usage: usageFrom(payload, Date.now() - startedAt),
    };
  }
  return normalizeResult(input.operation, payload, undefined, Date.now() - startedAt);
}

/** Poll a crawl or agent job through the same credential and error boundary. */
export async function pollFirecrawlJob(
  operation: "crawl" | "agent",
  jobId: string,
  context: FirecrawlContext = {},
): Promise<FirecrawlResult | FirecrawlJob> {
  return runFirecrawl({ operation, jobId }, context);
}

function credentialFor(): string {
  if (!env.firecrawlKey) {
    throw new FirecrawlError("missing_credential", "Web research is not available on this server yet.");
  }
  return env.firecrawlKey;
}

async function validateRequest(input: FirecrawlRequest): Promise<FirecrawlRequest> {
  if (!input || typeof input !== "object") throw new FirecrawlError("invalid_input", "A Firecrawl operation is required.");
  const operation = input.operation;
  if (!("scrape search map crawl agent".split(" ") as string[]).includes(operation)) {
    throw new FirecrawlError("invalid_input", "Unsupported Firecrawl operation.");
  }
  if (input.jobId !== undefined && (typeof input.jobId !== "string" || !/^[a-zA-Z0-9_-]{1,200}$/.test(input.jobId))) {
    throw new FirecrawlError("invalid_input", "Invalid Firecrawl job id.");
  }
  if (input.urls !== undefined && (!Array.isArray(input.urls) || input.urls.length > 10)) {
    throw new FirecrawlError("invalid_input", "Firecrawl accepts at most 10 public URLs per operation.");
  }
  if (input.schema !== undefined && (!isRecord(input.schema) || serializedSize(input.schema) > 20_000)) {
    throw new FirecrawlError("invalid_input", "The structured extraction schema must be a JSON object under 20,000 characters.");
  }
  if (input.format !== undefined && input.format !== "markdown" && input.format !== "html") {
    throw new FirecrawlError("invalid_input", "Scrape format must be markdown or html.");
  }

  const url = input.url ? await publicUrl(input.url) : undefined;
  const urls = input.urls?.length ? await Promise.all(input.urls.slice(0, 10).map(publicUrl)) : undefined;
  if (urls?.some((value): value is null => value === null)) {
    throw new FirecrawlError("invalid_input", "Every Firecrawl URL must be a public HTTP(S) URL.");
  }
  if ((operation === "scrape" || operation === "map" || operation === "crawl") && !url && !input.jobId) {
    throw new FirecrawlError("invalid_input", `${operation} requires a public URL.`);
  }
  if (operation === "search") {
    const query = typeof input.query === "string" ? input.query.trim() : "";
    if (!query || query.length > 500) throw new FirecrawlError("invalid_input", "Search query must be 1–500 characters.");
    return { ...input, url: url ?? undefined, query, limit: boundedLimit(input.limit, 10) };
  }
  if (operation === "agent") {
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (!prompt || prompt.length > 4_000) throw new FirecrawlError("invalid_input", "Agent prompt must be 1–4,000 characters.");
    if (!input.jobId && !url && !urls?.length) throw new FirecrawlError("invalid_input", "Agent requires at least one public URL.");
    return { ...input, url: url ?? undefined, urls: urls?.filter((value): value is string => !!value), prompt };
  }
  return { ...input, url: url ?? undefined, urls: urls?.filter((value): value is string => !!value) };
}

async function publicUrl(raw: string): Promise<string | null> {
  if (typeof raw !== "string" || raw.trim().length > 2_048) return null;
  return assertPublicUrl(raw);
}

function boundedLimit(value: unknown, max: number): number {
  if (value === undefined) return max;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new FirecrawlError("invalid_input", `Result limit must be a whole number from 1 to ${max}.`);
  }
  return value;
}

function operationRequest(input: FirecrawlRequest): { path: string; method: "POST"; body: Record<string, unknown> } {
  switch (input.operation) {
    case "scrape":
      return {
        path: "/v2/scrape",
        method: "POST",
        body: {
          url: input.url,
          formats: [input.format ?? "markdown"],
          onlyMainContent: input.onlyMainContent ?? true,
        },
      };
    case "search":
      return { path: "/v2/search", method: "POST", body: { query: input.query, limit: input.limit } };
    case "map":
      return { path: "/v2/map", method: "POST", body: { url: input.url, limit: boundedLimit(input.limit, 100) } };
    case "crawl":
      return { path: "/v2/crawl", method: "POST", body: { url: input.url, limit: boundedLimit(input.limit, 100) } };
    case "agent":
      return {
        path: "/v2/agent",
        method: "POST",
        body: {
          prompt: input.prompt,
          ...(input.urls?.length ? { urls: input.urls } : { urls: [input.url] }),
          ...(input.schema ? { schema: input.schema } : {}),
        },
      };
  }
}

async function requestJson(
  fetcher: typeof fetch,
  url: string,
  apiKey: string,
  method: "GET" | "POST",
  body?: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Record<string, unknown>> {
  try {
    const response = await fetcher(url, {
      method,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${apiKey}` },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw providerError(response.status);
    if (!payload || typeof payload !== "object") throw new FirecrawlError("provider_error", "Firecrawl returned an invalid response.");
    return payload as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FirecrawlError) throw error;
    if ((error as { name?: string })?.name === "TimeoutError" || (error as { name?: string })?.name === "AbortError") {
      throw new FirecrawlError("timeout", "Firecrawl timed out. Retry the operation.", 408, true);
    }
    throw new FirecrawlError("provider_unavailable", "Firecrawl could not be reached. Retry the operation.", undefined, true);
  }
}

function providerError(status: number): FirecrawlError {
  if (status === 401 || status === 403) {
    // A rejected key is an operator problem: the customer never supplied one
    // and cannot replace it, so they get the plain outage sentence.
    return new FirecrawlError(
      "unauthorized",
      setupNotice(
        "Web research isn't available right now. Please try again later.",
        "Firecrawl rejected FIRECRAWL_API_KEY.",
      ),
      status,
    );
  }
  if (status === 402) return new FirecrawlError("payment_required", "The Firecrawl account has no available credits.", status);
  if (status === 408) return new FirecrawlError("timeout", "Firecrawl timed out. Retry the operation.", status, true);
  if (status === 429) return new FirecrawlError("rate_limited", "Firecrawl is rate-limiting this key. Retry shortly.", status, true);
  if (status >= 500) return new FirecrawlError("provider_unavailable", "Firecrawl is temporarily unavailable. Retry shortly.", status, true);
  return new FirecrawlError("provider_error", "Firecrawl rejected the operation.", status);
}

function normalizeJobResponse(
  operation: "crawl" | "agent",
  jobId: string,
  payload: Record<string, unknown>,
  durationMs: number,
): FirecrawlResult | FirecrawlJob {
  const status = stringValue(payload.status).toLowerCase();
  if (["failed", "error"].includes(status)) throw new FirecrawlError("provider_error", `Firecrawl ${operation} job failed.`);
  if (["completed", "done", "success"].includes(status) || payload.data !== undefined) {
    return normalizeResult(operation, payload, jobId, durationMs);
  }
  return {
    kind: "job",
    operation,
    jobId,
    status: status === "scraping" ? "scraping" : status === "processing" ? "processing" : "queued",
    sources: collectSources(payload).slice(0, MAX_SOURCES),
    usage: usageFrom(payload, durationMs),
  };
}

function normalizeResult(
  operation: FirecrawlOperation,
  payload: Record<string, unknown>,
  jobId: string | undefined,
  durationMs: number,
): FirecrawlResult {
  const rawData = payload.data ?? payload;
  const data = sanitizeAndTruncate(rawData);
  const text = extractText(rawData);
  const rawMetadata = isRecord(payload.metadata)
    ? payload.metadata
    : isRecord(rawData) && isRecord(rawData.metadata)
      ? rawData.metadata
      : undefined;
  const result: FirecrawlResult = {
    kind: "result",
    operation,
    status: "completed",
    ...(text ? { text: text.slice(0, MAX_TEXT_CHARS) } : {}),
    ...(data !== undefined ? { data } : {}),
    sources: collectSources(payload).slice(0, MAX_SOURCES),
    ...(rawMetadata ? { metadata: sanitizeAndTruncate(rawMetadata) as Record<string, unknown> } : {}),
    ...(jobId ? { jobId } : {}),
    usage: usageFrom(payload, durationMs),
  };
  return result;
}

function usageFrom(payload: Record<string, unknown>, durationMs: number): FirecrawlUsage {
  const credits = Number(payload.creditsUsed ?? payload.credits_used);
  return { ...(Number.isFinite(credits) ? { creditsUsed: credits } : {}), durationMs };
}

function collectSources(value: unknown, out: string[] = []): string[] {
  if (out.length >= MAX_SOURCES || value == null) return out;
  if (typeof value === "string" && /^https?:\/\//i.test(value)) out.push(value);
  else if (Array.isArray(value)) for (const item of value) collectSources(item, out);
  else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (["url", "sourceURL", "sourceUrl", "link"].includes(key) && typeof item === "string" && /^https?:\/\//i.test(item)) out.push(item);
      else if (
        ["metadata", "data", "web", "news", "links", "results", "items", "documents", "pages", "sources"].includes(key)
      ) {
        collectSources(item, out);
      }
    }
  }
  return [...new Set(out)];
}

function extractText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractText).filter(Boolean).join("\n\n") || undefined;
  if (!isRecord(value)) return undefined;
  for (const key of ["markdown", "html", "content", "description", "text"]) {
    if (typeof value[key] === "string") return value[key] as string;
  }
  for (const key of ["data", "web", "results", "links", "items"]) {
    const nested = extractText(value[key]);
    if (nested) return nested;
  }
  return undefined;
}

function sanitizeAndTruncate(value: unknown): unknown {
  const sanitized = sanitize(value);
  return truncateValue(sanitized, MAX_DATA_BYTES);
}

/** Keep structured output useful while imposing a hard serialized-size cap. */
function truncateValue(value: unknown, budget: number): unknown {
  if (budget <= 0) return undefined;
  if (typeof value === "string") {
    return value.length <= budget ? value : `${value.slice(0, Math.max(0, budget - 1))}…`;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      const remaining = budget - serializedSize(out) - 2;
      if (remaining <= 0) break;
      const next = truncateValue(item, remaining);
      if (next === undefined) break;
      out.push(next);
      if (serializedSize(out) > budget) {
        out.pop();
        break;
      }
    }
    return out;
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const remaining = budget - serializedSize(out) - key.length - 6;
      if (remaining <= 0) break;
      const next = truncateValue(item, remaining);
      if (next === undefined) break;
      out[key] = next;
      if (serializedSize(out) > budget) delete out[key];
      if (serializedSize(out) >= budget) break;
    }
    return out;
  }
  return undefined;
}

function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, MAX_SOURCES).map(sanitize);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/api[_-]?key|authorization|password|secret|access[_-]?token|refresh[_-]?token/i.test(key)) continue;
    out[key] = sanitize(item);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function extractJobId(url: string): string {
  return url.split("/").filter(Boolean).pop() ?? "";
}
