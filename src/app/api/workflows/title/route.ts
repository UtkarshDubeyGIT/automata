import { NextResponse } from "next/server";
import { generateConversationTitle } from "@/lib/ai/openai";
import { fallbackConversationTitle } from "@/lib/ai/conversation-title";
import { jsonBody } from "@/lib/request";
import { resolveRequestContext } from "@/lib/workspace";

export async function POST(req: Request) {
  const { workspaceId } = await resolveRequestContext();
  if (!workspaceId) {
    return NextResponse.json({ error: "Sign in to rename this conversation" }, { status: 401 });
  }

  const body = await jsonBody<{ prompt?: unknown }>(req);
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 1600) : "";
  if (!prompt) {
    return NextResponse.json({ error: "Conversation text is required" }, { status: 400 });
  }

  try {
    const title = await generateConversationTitle(prompt);
    return NextResponse.json({ title });
  } catch (error) {
    console.warn("[workflows/title] title generation failed; using a local fallback:", error);
    return NextResponse.json({ title: fallbackConversationTitle(prompt) });
  }
}
