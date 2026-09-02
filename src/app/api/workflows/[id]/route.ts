import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { WorkflowGraph } from "@/lib/workflows/types";
import { validateDraftEnvelope, type WorkflowPositions } from "@/lib/workflows/editor";

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  if (!supabase) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to save a workflow." }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { name?: string; description?: string; graph?: WorkflowGraph; positions?: WorkflowPositions; baseRevision?: number };
  if (!body.graph) return NextResponse.json({ error: "A workflow graph is required." }, { status: 400 });
  const positions = body.positions ?? {};
  const envelopeErrors = validateDraftEnvelope(body.graph, positions);
  if (envelopeErrors.length) return NextResponse.json({ error: envelopeErrors[0], details: envelopeErrors }, { status: 400 });
  const { data: workflow } = await supabase.from("workflows").select("id,workspace_id,draft_revision").eq("id", id).single();
  if (!workflow) return NextResponse.json({ error: "Workflow not found." }, { status: 404 });
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", workflow.workspace_id).eq("user_id", userId).single();
  if (!membership || membership.role === "viewer") return NextResponse.json({ error: "Your workspace role cannot edit workflows." }, { status: 403 });
  const expectedRevision = Number.isInteger(body.baseRevision) ? Number(body.baseRevision) : Number(workflow.draft_revision ?? 0);
  const nextRevision = expectedRevision + 1;
  const updates: Record<string, unknown> = { draft_graph: body.graph, draft_positions: positions, draft_revision: nextRevision, draft_updated_by: userId };
  if (body.name?.trim()) updates.name = body.name.trim().slice(0, 120);
  if (body.description !== undefined) updates.description = body.description.slice(0, 1_000);
  const { data: saved, error } = await supabase.from("workflows").update(updates).eq("id", id).eq("draft_revision", expectedRevision).select("draft_revision").maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!saved) return NextResponse.json({ error: "A newer draft was saved by another editor.", code: "revision_conflict", revision: workflow.draft_revision }, { status: 409 });
  return NextResponse.json({ revision: saved.draft_revision });
}
