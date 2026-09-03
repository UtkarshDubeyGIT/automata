import OpenAI from "openai";
import { env, openaiConfigured } from "@/lib/env";

let _client: OpenAI | null = null;
function client() {
  if (!_client) _client = new OpenAI({ apiKey: env.openaiKey });
  return _client;
}

export { openaiConfigured };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Low-level chat completion. When OPENAI_API_KEY is absent, returns a
 * deterministic mock so screens still function in preview/dev.
 */
export async function chat(
  messages: ChatMessage[],
  opts?: {
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    model?: string;
    timeoutMs?: number;
  },
): Promise<string> {
  if (!openaiConfigured) {
    return mockReply(messages);
  }
  const model = opts?.model || env.openaiModel;
  const maxTokens = opts?.maxTokens ?? 900;
  const isReasoningModel = /^(gpt-5|o[134])/i.test(model);

  const res = await client().chat.completions.create({
    model,
    messages,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
    ...(isReasoningModel
      ? {
          max_completion_tokens: maxTokens + 1024,
          reasoning_effort: "low" as const,
        }
      : { max_tokens: maxTokens, temperature: opts?.temperature ?? 0.8 }),
  }, opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
  return res.choices[0]?.message?.content?.trim() ?? "";
}

export function explainAiError(err: unknown): string {
  const e = err as { status?: number; code?: string; message?: string; error?: { code?: string; message?: string } };
  const code = e?.error?.code ?? e?.code ?? "";
  const status = e?.status;
  const detail = e?.error?.message ?? e?.message ?? "";

  if (code === "insufficient_quota" || (status === 429 && /quota|billing/i.test(detail))) {
    return "OpenAI quota exhausted — add billing credit to the OPENAI_API_KEY account, then retry.";
  }
  if (status === 429) return "OpenAI is rate-limiting this key. Wait a moment and retry.";
  if (status === 401 || code === "invalid_api_key") {
    return "OPENAI_API_KEY is invalid or revoked.";
  }
  if (status === 404 || code === "model_not_found") {
    return `OpenAI rejected the configured model${detail ? ` — ${detail}` : ""}. Check OPENAI_MODEL.`;
  }
  if (detail.includes("did not return valid JSON")) {
    return "The model returned malformed JSON.";
  }
  return detail ? `AI request failed: ${detail}` : "AI request failed.";
}

/** Chat that expects and parses a JSON object response. */
export async function chatJSON<T = unknown>(
  messages: ChatMessage[],
  opts?: { temperature?: number; maxTokens?: number; model?: string; timeoutMs?: number },
): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as T;
    throw new Error("Model did not return valid JSON");
  }
}

function mockReply(messages: ChatMessage[]): string {
  const last = messages[messages.length - 1]?.content ?? "";
  if (/json/i.test(messages[0]?.content ?? "")) {
    return "{}";
  }
  return `(Preview mode — add OPENAI_API_KEY to generate live from: "${last.slice(0, 80)}")`;
}
