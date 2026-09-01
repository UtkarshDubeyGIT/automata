import "server-only";

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import OpenAI from "openai";

import type { ExecutionAdapter, ExecutionContext, JournalEvent, ModuleOutcome } from "./engine";
import type { WorkflowStep } from "./types";

type JournalWriter = (event: JournalEvent) => Promise<void>;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  return parts[0] === 10 || parts[0] === 127 || (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168) || parts[0] === 0;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) return privateIpv4(address);
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new Error("HTTP module only supports http and https URLs.");
  if (url.username || url.password) throw new Error("Credentials are not allowed in the URL.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) throw new Error("Private network destinations are not allowed.");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => privateAddress(address))) throw new Error("Private network destinations are not allowed.");
  return url;
}

async function executeHttp(step: WorkflowStep): Promise<ModuleOutcome> {
  const url = await assertPublicUrl(String(step.url ?? ""));
  const method = String(step.method ?? "GET").toUpperCase();
  const headers = Object.fromEntries(Object.entries(object(step.headers)).map(([key, value]) => [key, String(value)]));
  for (const name of ["host", "content-length", "connection", "transfer-encoding"]) delete headers[name];
  const body = ["GET", "HEAD"].includes(method) ? undefined : JSON.stringify(step.body ?? {});
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const output = contentType.includes("application/json") ? await response.json() : { text: (await response.text()).slice(0, 100_000) };
  if (!response.ok) return { outcome: "failed", error: `HTTP ${response.status}`, output };
  return { outcome: "succeeded", output: { status: response.status, headers: Object.fromEntries(response.headers), body: output } };
}

async function executeAi(step: WorkflowStep, input: unknown): Promise<ModuleOutcome> {
  if (!process.env.OPENAI_API_KEY) return { outcome: "failed", error: "OPENAI_API_KEY is not configured." };
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL ?? "gpt-5-mini",
    instructions: String(step.instructions ?? step.instruction ?? "Return only what the workflow asks for."),
    input: `${String(step.prompt ?? "Process this input.")}\n\nINPUT:\n${JSON.stringify(input)}`,
  });
  const tokens = response.usage?.total_tokens ?? 1;
  return { outcome: "succeeded", output: { text: response.output_text }, providerCredits: Math.max(1, Math.ceil(tokens / 1_000)) };
}

async function executeImage(step: WorkflowStep): Promise<ModuleOutcome> {
  if (!process.env.OPENAI_API_KEY) return { outcome: "failed", error: "OPENAI_API_KEY is not configured." };
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.images.generate({
    model: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
    prompt: String(step.prompt ?? ""),
    size: (step.size === "1024x1536" || step.size === "1536x1024" ? step.size : "1024x1024"),
  });
  const image = response.data?.[0];
  if (!image) return { outcome: "failed", error: "Image provider returned no image." };
  return { outcome: "succeeded", output: { url: image.url, base64: image.b64_json }, providerCredits: Number(step.providerCredits ?? 1) };
}

async function executeComposio(step: WorkflowStep, workspaceId: string): Promise<ModuleOutcome> {
  if (!process.env.COMPOSIO_API_KEY) return { outcome: "failed", error: "COMPOSIO_API_KEY is not configured." };
  const tool = String(step.action ?? "");
  if (!/^[A-Z0-9_]{2,160}$/i.test(tool)) return { outcome: "failed", error: "A valid Composio tool slug is required." };
  const response = await fetch(`https://backend.composio.dev/api/v3/tools/execute/${encodeURIComponent(tool)}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": process.env.COMPOSIO_API_KEY },
    body: JSON.stringify({ user_id: workspaceId, arguments: object(step.arguments), version: "latest" }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as { successful?: boolean; error?: string; data?: Record<string, unknown> };
  if (!response.ok || !body.successful) return { outcome: "failed", error: body.error ?? `Composio ${response.status}`, output: body.data };
  return { outcome: "succeeded", output: body.data ?? {} };
}

function compare(left: unknown, operator: string, right: unknown): boolean {
  if (operator === "equals") return left === right;
  if (operator === "not_equals") return left !== right;
  if (operator === "contains") return String(left).includes(String(right));
  if (operator === "greater_than") return Number(left) > Number(right);
  if (operator === "less_than") return Number(left) < Number(right);
  if (operator === "exists") return left !== null && left !== undefined && left !== "";
  throw new Error(`Unknown filter operator: ${operator}.`);
}

async function executeModule(step: WorkflowStep, input: unknown, context: ExecutionContext, workspaceId: string): Promise<ModuleOutcome> {
  if (step.type === "http_request") return executeHttp(step);
  if (step.type === "ai") return executeAi(step, input);
  if (step.type === "image") return executeImage(step);
  if (step.type === "app_action") return executeComposio(step, workspaceId);
  if (step.type === "transform") return { outcome: "succeeded", output: step.mapping ?? input };
  if (step.type === "filter") return { outcome: "succeeded", output: { passed: compare(step.left, String(step.operator ?? "equals"), step.right), input } };
  if (step.type === "router") return { outcome: "succeeded", output: { route: step.route, input } };
  if (step.type === "iterator") return { outcome: "succeeded", output: Array.isArray(step.items) ? step.items : [] };
  if (step.type === "aggregator") return { outcome: "succeeded", output: step.items ?? context.steps };
  if (step.type === "log") return { outcome: "succeeded", output: input };
  return { outcome: "failed", error: `Unsupported module type: ${step.type}.` };
}

export function createProductionAdapter(workspaceId: string, journal: JournalWriter): ExecutionAdapter {
  return { execute: (step, input, context) => executeModule(step, input, context, workspaceId), journal };
}
