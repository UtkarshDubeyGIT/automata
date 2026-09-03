import { NextResponse, type NextRequest } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { deriveDisplay, scheduleText } from "@/lib/workflows/display";
import { validateDraftEnvelope, type WorkflowPositions } from "@/lib/workflows/editor";
import type { WorkflowConfig, WorkflowGraph } from "@/lib/workflows/types";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) return NextResponse.json({ error: "Sign in to save a copy" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { graph?: WorkflowGraph; positions?: WorkflowPositions; name?: string } | null;
  if (!body?.graph) return NextResponse.json({ error: "Missing workflow graph" }, { status: 400 });
  const errors = validateDraftEnvelope(body.graph, body.positions ?? {});
  if (errors.length) return NextResponse.json({ error: errors[0] }, { status: 400 });
  const { data: source } = await rc.supabase.from("workflows").select("config, name, description").eq("id", id).maybeSingle();
  if (!source) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const draft: WorkflowConfig = { v: 1, graph: body.graph, display: { groups: deriveDisplay(body.graph) } };
  const { data, error } = await rc.supabase.from("workflows").insert({
    workspace_id: rc.workspaceId,
    name: `${String(body.name ?? source.name).slice(0, 52)} — copy`,
    description: source.description,
    active: false,
    schedule: scheduleText(source.config as WorkflowConfig),
    config: source.config,
    draft_config: draft,
    draft_positions: body.positions ?? {},
    draft_revision: 1,
    draft_updated_by: rc.userId,
  }).select("id").single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not save a copy" }, { status: 502 });
  return NextResponse.json({ id: data.id });
}
