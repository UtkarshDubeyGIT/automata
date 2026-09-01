import OpenAI from "openai";
import { NextResponse, type NextRequest } from "next/server";

import { INTEGRATIONS } from "@/lib/integrations/catalog";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { applySafetyDefaults } from "@/lib/workflows/safety";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { validateGraph } from "@/lib/workflows/validate";

function parseGraph(text: string): WorkflowGraph {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(cleaned) as WorkflowGraph;
}

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) return NextResponse.json({ error: "Sign in to use the AI builder." }, { status: 401 });
  if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY is not configured." }, { status: 503 });
  const body = await request.json().catch(() => ({})) as { prompt?: string; allowUnattendedWrites?: boolean };
  const prompt = body.prompt?.trim().slice(0, 4_000);
  if (!prompt) return NextResponse.json({ error: "Describe the workflow you want." }, { status: 400 });
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.responses.create({
    model: process.env.OPENAI_TEXT_MODEL ?? "gpt-5-mini",
    instructions: `You design a safe, acyclic workflow graph. Return only JSON with {"start":"step_id","steps":{"step_id":{...}}}. Supported step types: manual_trigger, schedule_trigger, webhook_trigger, app_event_trigger, app_action, http_request, ai, image, transform, filter, router, iterator, aggregator, approval, log. Every step needs id, type, name, and explicit next/onFalse/onApprove/onReject edges. Never emit code. Never emit destructive, financial, deletion, payment, transfer, credential, or permission-changing actions. Use only these app slugs: ${INTEGRATIONS.map((item) => item.slug).join(", ")}. App actions require a real uppercase Composio tool slug in action and read/write in operation.`,
    input: prompt,
  });
  try {
    const authored = parseGraph(response.output_text);
    const graph = applySafetyDefaults(authored, { allowUnattendedWrites: body.allowUnattendedWrites === true });
    const errors = validateGraph(graph);
    if (errors.length) return NextResponse.json({ error: "The generated workflow needs another pass.", details: errors }, { status: 422 });
    return NextResponse.json({ graph, safetyApplied: body.allowUnattendedWrites !== true });
  } catch {
    return NextResponse.json({ error: "The AI builder returned an invalid workflow. Try a more specific description." }, { status: 422 });
  }
}
