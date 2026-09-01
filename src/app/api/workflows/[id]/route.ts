import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import { applySafetyDefaults } from "@/lib/workflows/safety";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { validateGraph } from "@/lib/workflows/validate";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to save a workflow." }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { name?: string; description?: string; graph?: WorkflowGraph; allowUnattendedWrites?: boolean; changeSummary?: string };
  if (!body.graph) return NextResponse.json({ error: "A workflow graph is required." }, { status: 400 });
  const { data: workflow } = await supabase.from("workflows").select("id,workspace_id").eq("id", id).single();
  if (!workflow) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", workflow.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot edit workflows." }, { status: 403 });
  const graph = applySafetyDefaults(body.graph, { allowUnattendedWrites: body.allowUnattendedWrites === true });
  const errors = validateGraph(graph);
  if (errors.length) return NextResponse.json({ error: "Workflow graph is invalid.", details: errors }, { status: 400 });
  const { data: latest } = await supabase.from("workflow_versions").select("version").eq("workflow_id", id).order("version", { ascending: false }).limit(1).single();
  const { data: version, error } = await supabase.from("workflow_versions").insert({ workflow_id: id, workspace_id: workflow.workspace_id, version: Number(latest?.version ?? 0) + 1, graph, change_summary: body.changeSummary?.slice(0, 240) ?? "Draft updated", created_by: userId }).select("id,version").single();
  if (error || !version) return NextResponse.json({ error: error?.message ?? "Draft could not be saved." }, { status: 500 });
  const updates: Record<string, unknown> = { draft_version_id: version.id };
  if (body.name?.trim()) updates.name = body.name.trim().slice(0, 120);
  if (body.description !== undefined) updates.description = body.description.slice(0, 1_000);
  await supabase.from("workflows").update(updates).eq("id", id);
  return NextResponse.json({ version });
}
