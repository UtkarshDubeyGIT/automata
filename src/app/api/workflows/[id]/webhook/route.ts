import type { NextRequest } from "next/server";
import { receiveWorkflowWebhook } from "@/lib/workflows/webhook-receiver";

/**
 * 60 covered a receive-and-enqueue. The 202 now starts the run in an
 * `after(...)` continuation, which runs under the route's max duration, so
 * this is sized to a workflow run like `workflows/[id]/run` is. A hint only on
 * this self-hosted droplet (see src/app/api/AGENTS.md) -- the beat still
 * recovers anything the continuation does not finish.
 */
export const maxDuration = 300;

/** Legacy endpoint retained for existing configured senders. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const token = req.headers.get("x-webhook-token") ?? req.nextUrl.searchParams.get("token") ?? "";
  return receiveWorkflowWebhook(req, id, token);
}
