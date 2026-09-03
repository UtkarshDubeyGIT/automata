import type { NextRequest } from "next/server";
import { receiveWorkflowWebhook } from "@/lib/workflows/webhook-receiver";

export const maxDuration = 60;

/** Legacy endpoint retained for existing configured senders. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const token = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token") ?? "";
  return receiveWorkflowWebhook(req, id, token);
}
