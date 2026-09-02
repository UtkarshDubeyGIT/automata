import { createHash, randomBytes } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { applySafetyDefaults } from "@/lib/workflows/safety";
import { TEMPLATES } from "@/lib/workflows/templates";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { validateGraph } from "@/lib/workflows/validate";
import { validateDraftEnvelope, type WorkflowPositions } from "@/lib/workflows/editor";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to create a workflow." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { workspaceId?: string; templateId?: string; name?: string; description?: string; graph?: WorkflowGraph; positions?: WorkflowPositions; allowUnattendedWrites?: boolean };
  const membershipQuery = supabase.from("workspace_members").select("workspace_id,role").eq("user_id", userId);
  const { data: membership } = body.workspaceId ? await membershipQuery.eq("workspace_id", body.workspaceId).single() : await membershipQuery.order("joined_at").limit(1).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot create workflows." }, { status: 403 });
  const template = TEMPLATES.find((item) => item.id === body.templateId);
  const authoredGraph = body.graph ?? template?.graph;
  if (!authoredGraph) return NextResponse.json({ error: "Provide a graph or a valid template." }, { status: 400 });
  const positions = body.positions ?? {};
  const envelopeErrors = validateDraftEnvelope(authoredGraph, positions);
  if (envelopeErrors.length) return NextResponse.json({ error: envelopeErrors[0], details: envelopeErrors }, { status: 400 });
  const graph = applySafetyDefaults(authoredGraph, { allowUnattendedWrites: body.allowUnattendedWrites === true });
  const errors = validateGraph(graph);
  const name = (body.name ?? template?.name ?? "Untitled automation").trim().slice(0, 120);
  const webhookToken = Object.values(graph.steps).some((step) => step.type === "webhook_trigger") ? randomBytes(24).toString("base64url") : null;
  const { data: workflow, error: workflowError } = await supabase.from("workflows").insert({
    workspace_id: membership.workspace_id,
    name,
    description: (body.description ?? template?.description ?? "").slice(0, 1_000),
    created_by: userId,
    draft_graph: graph,
    draft_positions: positions,
    draft_revision: 1,
    draft_updated_by: userId,
    webhook_token_hash: webhookToken ? createHash("sha256").update(webhookToken).digest("hex") : null,
  }).select("id").single();
  if (workflowError || !workflow) return NextResponse.json({ error: workflowError?.message ?? "Workflow could not be created." }, { status: 500 });
  // An incomplete first draft is still valuable work. Immutable versions begin
  // once the graph is executable; autosave never has to manufacture one.
  if (errors.length) {
    return NextResponse.json({ workflow: { id: workflow.id, versionId: null, webhookToken }, draftIssues: errors }, { status: 201 });
  }
  const { data: version, error: versionError } = await supabase.from("workflow_versions").insert({ workflow_id: workflow.id, workspace_id: membership.workspace_id, version: 1, graph, change_summary: template ? `Created from ${template.name}` : "Initial draft", created_by: userId }).select("id").single();
  if (versionError || !version) {
    await supabase.from("workflows").delete().eq("id", workflow.id);
    return NextResponse.json({ error: versionError?.message ?? "Draft version could not be saved." }, { status: 500 });
  }
  await supabase.from("workflows").update({ draft_version_id: version.id }).eq("id", workflow.id);
  return NextResponse.json({ workflow: { id: workflow.id, versionId: version.id, webhookToken } }, { status: 201 });
}
