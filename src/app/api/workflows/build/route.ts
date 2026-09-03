import { after, NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { jsonBody } from "@/lib/request";
import {
  enqueueWorkflowBuild,
  kickWorkflowBuilds,
  workflowBuildView,
  type BuildJobDb,
} from "@/lib/workflows/build-jobs";

/**
 * Persist and charge before returning. The provider work runs after the 202,
 * so a proxy timeout can no longer hide a completed, billed build.
 */
export const maxDuration = 90;

export async function POST(req: Request) {
  // There was no 401 here at all, so an anonymous caller fell straight past
  // the `if (rc.workspaceId)` charge and got a free OpenAI call — an unmetered
  // model endpoint open to the internet.
  const rc = await resolveRequestContext();
  const workspaceId = rc.workspaceId;
  if (!workspaceId) {
    return NextResponse.json({ error: "Sign in to build automations" }, { status: 401 });
  }

  const body = await jsonBody(req);
  if (!body) {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const input = body as { prompt?: unknown; requestKey?: unknown };
  const prompt = typeof input.prompt === "string" ? input.prompt.trim().slice(0, 1000) : "";
  const requestKey = typeof input.requestKey === "string" ? input.requestKey.trim() : "";
  if (!prompt) {
    return NextResponse.json({ error: "Describe the automation you want" }, { status: 400 });
  }
  if (!requestKey || requestKey.length > 100) {
    return NextResponse.json({ error: "Missing build request key" }, { status: 400 });
  }

  try {
    const queued = await enqueueWorkflowBuild(rc.supabase as unknown as BuildJobDb, {
      workspaceId,
      requestKey,
      prompt,
    });
    if (queued.outcome === "insufficient") {
      return NextResponse.json(
        { error: "Not enough credits", balance: queued.balance, cost: queued.cost },
        { status: 402 },
      );
    }

    after(kickWorkflowBuilds());
    return NextResponse.json(
      { job: workflowBuildView(queued.job) },
      { status: 202 },
    );
  } catch (err) {
    console.error("[workflows/build] enqueue failed:", err);
    return NextResponse.json({ error: "Could not queue the workflow build" }, { status: 502 });
  }
}
