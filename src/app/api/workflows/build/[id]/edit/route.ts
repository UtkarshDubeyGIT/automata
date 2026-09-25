import { NextResponse } from "next/server";
import { jsonBody } from "@/lib/request";
import { resolveRequestContext } from "@/lib/workspace";
import { createAdminClient } from "@/lib/supabase/server";
import {
  BuildError,
  editWorkflow,
  type BuildOutput,
} from "@/lib/workflows/builder";
import {
  claimWorkflowDraft,
  getWorkflowBuild,
  updateWorkflowBuildResult,
  type BuildJobDb,
} from "@/lib/workflows/build-jobs";

/** Revise an unsaved build in place while keeping its durable save identity. */
export const maxDuration = 120;

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to edit workflow drafts" }, { status: 401 });
  }

  const body = await jsonBody<{ instruction?: unknown; history?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  const instruction = typeof body.instruction === "string"
    ? body.instruction.trim().slice(0, 1000)
    : "";
  const history = typeof body.history === "string" ? body.history.trim().slice(-5000) : "";
  if (!instruction) {
    return NextResponse.json({ error: "Describe the change you want" }, { status: 400 });
  }

  const { id } = await ctx.params;
  const admin = createAdminClient();
  if (!admin) {
    return NextResponse.json({ error: "Workflow draft editing is unavailable" }, { status: 503 });
  }
  let lock: Awaited<ReturnType<typeof claimWorkflowDraft>> | undefined;
  try {
    lock = await claimWorkflowDraft(admin as unknown as BuildJobDb, id);
    if (!lock.ok) {
      return NextResponse.json({ error: "This draft is being edited or saved. Try again shortly." }, { status: 409 });
    }
    const job = await getWorkflowBuild(
      rc.supabase as unknown as BuildJobDb,
      id,
      rc.workspaceId,
    );
    if (job?.status !== "completed" || !job.result?.config?.graph) {
      return NextResponse.json({ error: "This workflow draft is no longer available" }, { status: 404 });
    }
    const current = job.result;

    const edit = await editWorkflow(
      {
        name: current.name,
        description: current.description,
        graph: current.config.graph,
        originalRequest: current.config.prompt ?? job?.prompt,
        conversation: history,
      },
      instruction,
    );
    const revised: BuildOutput = {
      ...current,
      name: edit.name,
      description: edit.description,
      config: {
        ...current.config,
        graph: edit.graph,
        display: { groups: edit.groups },
      },
      response: edit.response,
      groups: edit.groups,
      requiredApps: edit.requiredApps,
      needsBrand: edit.needsBrand,
    };

    const updated = await updateWorkflowBuildResult(
      admin as unknown as BuildJobDb,
      id,
      rc.workspaceId,
      revised,
    );
    if (!updated) {
      return NextResponse.json({ error: "This workflow draft changed or expired. Please try again." }, { status: 409 });
    }

    return NextResponse.json({ edit: { build: revised, updatedAt: updated } });
  } catch (err) {
    if (err instanceof BuildError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    console.error("[workflows/build/edit] failed:", err);
    return NextResponse.json({ error: "Could not update the workflow draft" }, { status: 502 });
  } finally {
    if (lock?.ok) await lock.release();
  }
}
