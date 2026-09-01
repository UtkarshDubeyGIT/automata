import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(request: NextRequest, { params }: Params) {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to delete a workspace." }, { status: 401 });
  const { id } = await params;
  const body = await request.json().catch(() => ({})) as { confirmation?: string };
  const { data: workspace } = await supabase.from("workspaces").select("id,name").eq("id", id).single();
  const { data: membership } = await supabase.from("workspace_members").select("role").eq("workspace_id", id).eq("user_id", userId).single();
  if (!workspace || membership?.role !== "owner") return NextResponse.json({ error: "Only a workspace owner can delete it." }, { status: 403 });
  if (body.confirmation !== workspace.name) return NextResponse.json({ error: "Type the exact workspace name to confirm deletion." }, { status: 400 });
  const { error } = await admin.from("workspaces").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
