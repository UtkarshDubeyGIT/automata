import { after, NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import {
  getWorkflowBuild,
  kickWorkflowBuilds,
  workflowBuildView,
  type BuildJobDb,
} from "@/lib/workflows/build-jobs";

export const maxDuration = 90;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to view workflow builds" }, { status: 401 });
  }

  const { id } = await ctx.params;
  try {
    const job = await getWorkflowBuild(
      rc.supabase as unknown as BuildJobDb,
      id,
      rc.workspaceId,
    );
    if (!job) {
      return NextResponse.json({ error: "Workflow build not found" }, { status: 404 });
    }
    if (job.status === "queued" || job.status === "running") {
      after(kickWorkflowBuilds());
    }
    return NextResponse.json({ job: workflowBuildView(job) });
  } catch (err) {
    console.error("[workflows/build] status failed:", err);
    return NextResponse.json({ error: "Could not read workflow build status" }, { status: 502 });
  }
}
