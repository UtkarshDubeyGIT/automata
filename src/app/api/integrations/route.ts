import { NextResponse, type NextRequest } from "next/server";

import { INTEGRATION_BY_SLUG } from "@/lib/integrations/catalog";
import { createConnectLink, listConnectedToolkits } from "@/lib/integrations/composio";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

async function context() {
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!supabase || !admin) return null;
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return null;
  const { data: membership } = await supabase.from("workspace_members").select("workspace_id,role").eq("user_id", userId).order("joined_at").limit(1).single();
  if (!membership) return null;
  return { supabase, admin, userId, workspaceId: membership.workspace_id, role: membership.role };
}

export async function GET() {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: "Sign in to view connections." }, { status: 401 });
  if (!process.env.COMPOSIO_API_KEY) {
    const { data } = await ctx.supabase.from("connections").select("app_slug,provider_account_id,status,display_name").eq("workspace_id", ctx.workspaceId);
    return NextResponse.json({ connections: data ?? [], live: false });
  }
  try {
    const live = await listConnectedToolkits(ctx.workspaceId);
    for (const connection of live) {
      await ctx.admin.from("connections").upsert({
        workspace_id: ctx.workspaceId,
        app_slug: connection.appSlug,
        provider_account_id: connection.accountId,
        status: connection.status,
        connected_by: ctx.userId,
        connected_at: connection.status === "connected" ? new Date().toISOString() : null,
      }, { onConflict: "workspace_id,app_slug,provider_account_id" });
    }
    return NextResponse.json({ connections: live, live: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connections could not be refreshed." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  const ctx = await context();
  if (!ctx) return NextResponse.json({ error: "Sign in to connect an app." }, { status: 401 });
  if (ctx.role !== "owner" && ctx.role !== "admin") return NextResponse.json({ error: "Only workspace admins can connect apps." }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { app?: string };
  const app = body.app?.toLowerCase() ?? "";
  if (!INTEGRATION_BY_SLUG.has(app)) return NextResponse.json({ error: "That integration is not in the MVP catalog." }, { status: 400 });
  const callback = new URL("/api/integrations/callback", request.url);
  callback.searchParams.set("app", app);
  try {
    const link = await createConnectLink(ctx.workspaceId, app, callback.toString());
    await ctx.admin.from("connections").upsert({ workspace_id: ctx.workspaceId, app_slug: app, provider_account_id: link.connected_account_id, status: "pending", connected_by: ctx.userId }, { onConflict: "workspace_id,app_slug,provider_account_id" });
    return NextResponse.json({ redirectUrl: link.redirect_url });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connection could not start." }, { status: 502 });
  }
}
