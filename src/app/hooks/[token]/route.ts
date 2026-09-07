import type { NextRequest } from "next/server";
import { receiveWorkflowWebhook } from "@/lib/workflows/webhook-receiver";

/**
 * 60 covered a receive-and-enqueue. The 202 now starts the run in an
 * `after(...)` continuation, which runs under the route's max duration, so
 * this is sized to a workflow run like `workflows/[id]/run` is.
 */
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> },
) {
  const value = (await ctx.params).token;
  const split = value.indexOf(".");
  if (split <= 0) return receiveWorkflowWebhook(req, "", "");
  return receiveWorkflowWebhook(req, value.slice(0, split), value.slice(split + 1));
}
