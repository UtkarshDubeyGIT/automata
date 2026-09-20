import { NextResponse, type NextRequest } from "next/server";

import { stripeClient, stripePrice } from "@/lib/billing/stripe";
import { billingWorkspace } from "@/lib/billing/workspace";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { publicUrl } from "@/lib/request";

export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const supabase = await createServerSupabaseClient();
  if (!stripe || !supabase) return NextResponse.json({ error: "Stripe or Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to change plans." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { plan?: string; annual?: boolean; workspaceId?: string };
  if (body.plan !== "pro") return NextResponse.json({ error: "Choose the Pro plan." }, { status: 400 });
  const workspace = await billingWorkspace(supabase, userId, body.workspaceId);
  if (!workspace) return NextResponse.json({ error: "Only workspace admins can change billing." }, { status: 403 });
  const price = stripePrice(body.plan, Boolean(body.annual));
  if (!price) return NextResponse.json({ error: `Stripe price for ${body.plan} is not configured.` }, { status: 503 });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: workspace.customerId ?? undefined,
    customer_email: workspace.customerId ? undefined : String(claims.claims.email ?? "") || undefined,
    client_reference_id: workspace.id,
    line_items: [{ price, quantity: 1 }],
    allow_promotion_codes: true,
    success_url: publicUrl("/app/billing?checkout=success", request).toString(),
    cancel_url: publicUrl("/app/billing?checkout=cancelled", request).toString(),
    subscription_data: { metadata: { workspace_id: workspace.id, plan: body.plan } },
    metadata: { workspace_id: workspace.id, plan: body.plan },
  });
  return NextResponse.json({ url: session.url });
}
