import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { validateDraftEnvelope, type WorkflowPositions } from "@/lib/workflows/editor";
import type { WorkflowGraph } from "@/lib/workflows/types";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to save a copy." }, { status: 401 });
  const body = await request.json().catch(() => null) as { graph?: WorkflowGraph; positions?: WorkflowPositions; name?: string } | null;
  if (!body?.graph) return NextResponse.json({ error: "Missing workflow graph." }, { status: 400 });
  const errors = validateDraftEnvelope(body.graph, body.positions ?? {});
  if (errors.length) return NextResponse.json({ error: errors[0] }, { status: 400 });

  const { data: source } = await supabase.from("workflows").select("workspace_id,name,description,published_version_id,draft_version_id").eq("id", id).maybeSingle();
  if (!source) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  const sourceVersionId = source.published_version_id ?? source.draft_version_id;
  const { data: sourceVersion } = sourceVersionId
    ? await supabase.from("workflow_versions").select("graph").eq("id", sourceVersionId).maybeSingle()
    : { data: null };
  const baseline = (sourceVersion?.graph ?? body.graph) as WorkflowGraph;
  const { data: workflow, error: workflowError } = await supabase.from("workflows").insert({
    workspace_id: source.workspace_id,
    name: `${String(body.name ?? source.name).slice(0, 110)} copy`,
    description: source.description,
    state: "draft",
    created_by: userId,
    draft_graph: body.graph,
    draft_positions: body.positions ?? {},
    draft_revision: 1,
    draft_updated_by: userId,
  }).select("id").single();
  if (workflowError || !workflow) return NextResponse.json({ error: workflowError?.message ?? "Could not save a copy." }, { status: 502 });
  const { data: version, error: versionError } = await supabase.from("workflow_versions").insert({ workflow_id: workflow.id, workspace_id: source.workspace_id, version: 1, graph: baseline, change_summary: "Copied workflow baseline", created_by: userId }).select("id").single();
  if (versionError || !version) return NextResponse.json({ error: versionError?.message ?? "Could not save the copy baseline." }, { status: 502 });
  await supabase.from("workflows").update({ draft_version_id: version.id, published_version_id: source.published_version_id ? version.id : null }).eq("id", workflow.id);
  return NextResponse.json({ id: workflow.id }, { status: 201 });
}
