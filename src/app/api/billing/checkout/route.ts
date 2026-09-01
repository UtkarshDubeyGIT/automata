import { NextResponse, type NextRequest } from "next/server";

import { stripeClient, stripePrice } from "@/lib/billing/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const supabase = await createServerSupabaseClient();
  const admin = createSupabaseAdminClient();
  if (!stripe || !supabase || !admin) return NextResponse.json({ error: "Stripe or Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to change plans." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { plan?: string; annual?: boolean; workspaceId?: string };
  if (body.plan !== "pro" && body.plan !== "team") return NextResponse.json({ error: "Choose the Pro or Team plan." }, { status: 400 });
  const membershipQuery = supabase.from("workspace_members").select("workspace_id,role").eq("user_id", userId);
  const { data: membership } = body.workspaceId ? await membershipQuery.eq("workspace_id", body.workspaceId).single() : await membershipQuery.order("joined_at").limit(1).single();
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) return NextResponse.json({ error: "Only workspace admins can change billing." }, { status: 403 });
  const price = stripePrice(body.plan, Boolean(body.annual));
  if (!price) return NextResponse.json({ error: `Stripe price for ${body.plan} is not configured.` }, { status: 503 });
  const { data: workspace } = await admin.from("workspaces").select("name,stripe_customer_id").eq("id", membership.workspace_id).single();

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: workspace?.stripe_customer_id ?? undefined,
    customer_email: workspace?.stripe_customer_id ? undefined : String(claims.claims.email ?? "") || undefined,
    client_reference_id: membership.workspace_id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: `${request.nextUrl.origin}/app/billing?checkout=success`,
    cancel_url: `${request.nextUrl.origin}/app/billing?checkout=cancelled`,
    subscription_data: { metadata: { workspace_id: membership.workspace_id, plan: body.plan } },
    metadata: { workspace_id: membership.workspace_id, plan: body.plan },
  });
  return NextResponse.json({ url: session.url });
}
