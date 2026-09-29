import { NextResponse, type NextRequest } from "next/server";
import { billingWorkspace } from "@/lib/billing/workspace";
import { emailReviewer, newReviewToken, reviewTokenHash, type ProAccessRequest } from "@/lib/billing/pro-access";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return NextResponse.json({ error: "Pro access requests are not configured." }, { status: 503 });
  const { data: { user }, error: authError } = await supabase.auth.getUser();
  if (authError || !user?.email) return NextResponse.json({ error: "Sign in to request Pro access." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { workspaceId?: string };
  const workspace = await billingWorkspace(supabase, user.id, body.workspaceId);
  if (!workspace) return NextResponse.json({ error: "Only workspace owners and admins can request Pro access." }, { status: 403 });
  const { data: workspaceRow, error: workspaceError } = await admin.from("workspaces")
    .select("id,name,plan").eq("id", workspace.id).maybeSingle();
  if (workspaceError || !workspaceRow) return NextResponse.json({ error: "Could not find this workspace." }, { status: 502 });
  if (workspaceRow.plan === "pro") return NextResponse.json({ error: "This workspace already has Pro access." }, { status: 409 });

  const { data: previous, error: readError } = await admin.from("pro_access_requests")
    .select("*").eq("workspace_id", workspace.id).eq("status", "pending").maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not check existing requests." }, { status: 502 });
  const existing = previous as ProAccessRequest | null;
  if ((existing?.email_status === "pending" &&
      new Date(existing.requested_at).getTime() > Date.now() - 60_000) ||
    (existing?.email_status === "sent" && new Date(existing.link_expires_at).getTime() > Date.now())) {
    return NextResponse.json({ status: "pending" });
  }

  const token = newReviewToken();
  const fields = {
    requested_by: user.id,
    requester_email: user.email,
    workspace_name: workspaceRow.name,
    token_hash: reviewTokenHash(token),
    link_expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    email_status: "pending",
  };
  const write = existing
    ? await admin.from("pro_access_requests").update(fields).eq("id", existing.id).eq("status", "pending")
      .eq("token_hash", existing.token_hash).select("*").single()
    : await admin.from("pro_access_requests").insert({ workspace_id: workspace.id, ...fields }).select("*").single();
  if (write.error || !write.data) {
    if (write.error?.code === "23505" || write.error?.code === "PGRST116") return NextResponse.json({ status: "pending" });
    return NextResponse.json({ error: "Could not save the request." }, { status: 502 });
  }
  const saved = write.data as ProAccessRequest;
  try {
    await emailReviewer(saved, token);
    await admin.from("pro_access_requests").update({ email_status: "sent" }).eq("id", saved.id);
    return NextResponse.json({ status: "pending" });
  } catch (error) {
    console.error("[pro-access] review email failed", error);
    await admin.from("pro_access_requests").update({ email_status: "failed" }).eq("id", saved.id);
    return NextResponse.json({ error: "The request was saved, but its email could not be delivered. Please retry." }, { status: 502 });
  }
}
