import { NextResponse, type NextRequest } from "next/server";

import { stripeClient } from "@/lib/billing/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!stripe || !supabase || !admin) return NextResponse.json({ error: "Stripe or Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { workspaceId?: string };
  const membershipQuery = supabase.from("workspace_members").select("workspace_id,role").eq("user_id", userId);
  const { data: membership } = body.workspaceId ? await membershipQuery.eq("workspace_id", body.workspaceId).single() : await membershipQuery.order("joined_at").limit(1).single();
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) return NextResponse.json({ error: "Only workspace admins can manage billing." }, { status: 403 });
  const { data: workspace } = await admin.from("workspaces").select("stripe_customer_id").eq("id", membership.workspace_id).single();
  if (!workspace?.stripe_customer_id) return NextResponse.json({ error: "This workspace has no Stripe customer yet." }, { status: 409 });
  const session = await stripe.billingPortal.sessions.create({ customer: workspace.stripe_customer_id, return_url: `${request.nextUrl.origin}/app/billing` });
  return NextResponse.json({ url: session.url });
}
