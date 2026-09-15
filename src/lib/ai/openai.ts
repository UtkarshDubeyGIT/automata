import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { env, openaiConfigured } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";

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

export interface ChatToolCall {
  id: string;
  name: string;
  arguments: string;
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
    /**
     * Per-request ceiling. The SDK's default is ten minutes, which is fine for
     * a user waiting on a page and wrong for anything running inside a claimed
     * step: a hung call there holds the claim until its TTL expires and blocks
     * every other worker from picking the row up. Callers that hold a lock
     * should always set this.
     */
    timeoutMs?: number;
  },
): Promise<string> {
  if (!openaiConfigured) {
    return mockReply(messages);
  }
  const model = opts?.model || env.openaiModel;
  const maxTokens = opts?.maxTokens ?? 900;

  // The GPT-5 family and o-series reasoning models changed the API contract:
  // `max_tokens` was renamed to `max_completion_tokens`, and only the default
  // temperature (1) is accepted. Sending the old params 400s — which is what
  // silently broke Trends/Viral when OPENAI_TRENDS_MODEL was set to gpt-5.5.
  // Older models (gpt-4o and earlier) keep the classic params.
  const isReasoningModel = /^(gpt-5|o[134])/i.test(model);

  const res = await client().chat.completions.create({
    model,
    messages,
    ...(opts?.json ? { response_format: { type: "json_object" } } : {}),

    ...(isReasoningModel
      ? {
          // Reasoning tokens are billed against the completion budget. Left
          // unchecked they consume the whole allowance and the visible JSON is
          // truncated — which silently produced EMPTY trend/hook sets. Keep the
          // effort low for these extraction/generation tasks (quality comes from
          // the prompt + research, not deep reasoning) and add token headroom.
          max_completion_tokens: maxTokens + 1024,
          reasoning_effort: "low" as const,
        }
      : { max_tokens: maxTokens, temperature: opts?.temperature ?? 0.8 }),
  }, opts?.timeoutMs ? { timeout: opts.timeoutMs } : undefined);
  return res.choices[0]?.message?.content?.trim() ?? "";
}

/** One chat completion with function tools. Agent loops enforce their own bounds. */
export async function chatWithTools(
  messages: ChatCompletionMessageParam[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
  opts: { model?: string; timeoutMs?: number; json?: boolean; maxTokens?: number } = {},
): Promise<{ content: string | null; toolCalls: ChatToolCall[] }> {
  if (!openaiConfigured) {
    const last = messages[messages.length - 1];
    return {
      content: `${setupNotice(
        "Preview mode — live AI is not switched on, so this is a sample response.",
        "Preview mode — add OPENAI_API_KEY to run agent tools.",
      )} ${typeof last?.content === "string" ? last.content.slice(0, 120) : ""}`,
      toolCalls: [],
    };
  }
  const model = opts.model || env.openaiModel;
  const maxTokens = opts.maxTokens ?? 1200;
  const isReasoningModel = /^(gpt-5|o[134])/i.test(model);
  const response = await client().chat.completions.create(
    {
      model,
      messages,
      tools: tools as unknown as ChatCompletionTool[],
      tool_choice: "auto",
      parallel_tool_calls: false,
      ...(opts.json ? { response_format: { type: "json_object" as const } } : {}),
      // Tools are the wrinkle that `chat()` doesn't have. On /v1/chat/completions the
      // gpt-5 family rejects function tools combined with ANY reasoning effort above
      // "none" — "use /v1/responses or set reasoning_effort to 'none'" — and omitting
      // the key 400s too, since the model then applies its own default. Verified
      // against gpt-5.6-terra and gpt-5.5. So it must be sent, explicitly, as "none".
      // That also means no reasoning tokens are billed here, so this budget needs no
      // headroom (unlike `chat()`, which pads by +1024).
      ...(isReasoningModel
        ? { max_completion_tokens: maxTokens, reasoning_effort: "none" as const }
        : { max_tokens: maxTokens, temperature: 0.2 }),
    },
    opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
  );
  const message = response.choices[0]?.message;
  return {
    content: message?.content ?? null,
    toolCalls: (message?.tool_calls ?? []).flatMap((call) =>
      call.type === "function"
        ? [{ id: call.id, name: call.function.name, arguments: call.function.arguments }]
        : [],
    ),
  };
}

/**
 * Turn a provider error into something the UI can act on.
 *
 * Every AI call site used to swallow failures and report one generic message,
 * so an expired API key, an exhausted quota and a typo'd model id all surfaced
 * as "Could not resolve your product category" — undiagnosable from the app.
 *
 * The diagnosis half of that is for whoever runs the app, not for a customer
 * watching a workflow fail, so the returned string keeps the variable names
 * only in local development. The log line below is what carries them in
 * production, where nobody is reading the screen for a fix anyway.
 */
export function explainAiError(err: unknown): string {
  const e = err as { status?: number; code?: string; message?: string; error?: { code?: string; message?: string } };
  const code = e?.error?.code ?? e?.code ?? "";
  const status = e?.status;
  const detail = e?.error?.message ?? e?.message ?? "";
  console.error("[ai/openai] request failed:", { status, code, detail });

  if (code === "insufficient_quota" || (status === 429 && /quota|billing/i.test(detail))) {
    return setupNotice(
      "The AI service has run out of capacity on our side. Please try again later.",
      "OpenAI quota exhausted — add billing credit to the OPENAI_API_KEY account, then retry.",
    );
  }
  if (status === 429) return "OpenAI is rate-limiting this key. Wait a moment and retry.";
  if (status === 401 || code === "invalid_api_key") {
    return setupNotice(
      "The AI service rejected our credentials. Please try again later.",
      "OPENAI_API_KEY is invalid or revoked.",
    );
  }
  if (status === 404 || code === "model_not_found") {
    return setupNotice(
      "The AI service is misconfigured on our side. Please try again later.",
      `OpenAI rejected the configured model${detail ? ` — ${detail}` : ""}. Check OPENAI_MODEL / OPENAI_TRENDS_MODEL.`,
    );
  }
  if (detail.includes("did not return valid JSON")) {
    return setupNotice(
      "The AI service returned an unusable answer. Please retry.",
      "The model returned malformed JSON. Retry, or lower OPENAI_TRENDS_MODEL to a known-good id.",
    );
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
    // Best-effort recovery: extract the first {...} block.
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
  const note = setupNotice(
    "Preview mode — live AI is not switched on, so this is sample copy generated from",
    "Preview mode — add OPENAI_API_KEY to generate live from",
  );
  return `Solo founders aren't lonely anymore.\n\nThey have a team of AI agents working 24/7.\n\nDesign. Code. Marketing. Growth.\n\nThe billion-dollar one-person company isn't a meme. It's already shipping.\n\n(${note}: "${last.slice(0, 80)}")`;
}
