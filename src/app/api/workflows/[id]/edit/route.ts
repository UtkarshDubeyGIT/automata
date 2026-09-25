import { NextResponse, type NextRequest } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { BuildError, editWorkflow } from "@/lib/workflows/builder";
import { getWorkflowRow } from "@/lib/workflows/store";
import { setupGaps } from "@/lib/workflows/validate";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * AI edit of an existing automation: plain-English change → a new, validated
 * graph. Nothing is persisted — the editor drops the result onto the canvas as
 * unsaved changes, so the user reviews (and can keep editing by hand) before
 * pressing Save.
 */
export const maxDuration = 120;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: { instruction?: string; graph?: WorkflowGraph; history?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const instruction = typeof body.instruction === "string"
    ? body.instruction.trim().slice(0, 1000)
    : "";
  const history = typeof body.history === "string" ? body.history.trim().slice(-5000) : "";
  if (!instruction) {
    return NextResponse.json({ error: "Describe the change you want" }, { status: 400 });
  }

  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to edit automations" }, { status: 401 });
  }

  const row = await getWorkflowRow(rc.supabase, id);
  if (!row) return NextResponse.json({ error: "Automation not found" }, { status: 404 });

  // Edit what's on the canvas (which may hold unsaved changes), falling back
  // to the stored graph — otherwise an AI edit would silently revert them.
  const graph = body.graph?.start ? body.graph : row.config?.graph;
  if (!graph?.start) {
    return NextResponse.json({ error: "This automation has no graph to edit" }, { status: 400 });
  }

  try {
    const result = await editWorkflow(
      {
        name: row.name,
        description: row.description ?? "",
        graph,
        originalRequest: row.config?.prompt,
        conversation: history,
      },
      instruction,
    );
    return NextResponse.json({ edit: { ...result, gaps: setupGaps(result.graph) } });
  } catch (err) {
    if (err instanceof BuildError) {
      return NextResponse.json({ error: err.message }, { status: 502 });
    }
    return NextResponse.json(
      { error: "The editor hit an unexpected error — try again" },
      { status: 502 },
    );
  }
}
