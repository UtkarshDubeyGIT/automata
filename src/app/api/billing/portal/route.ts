import { NextResponse, type NextRequest } from "next/server";

import { stripeClient } from "@/lib/billing/stripe";
import { billingWorkspace } from "@/lib/billing/workspace";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { publicUrl } from "@/lib/request";

export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const supabase = await createServerSupabaseClient();
  if (!stripe || !supabase) return NextResponse.json({ error: "Stripe or Supabase server keys are not configured." }, { status: 503 });
  const { data: claims } = await supabase.auth.getClaims();
  const userId = claims?.claims?.sub;
  if (!userId) return NextResponse.json({ error: "Sign in to manage billing." }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { workspaceId?: string };
  const workspace = await billingWorkspace(supabase, userId, body.workspaceId);
  if (!workspace) return NextResponse.json({ error: "Only workspace admins can manage billing." }, { status: 403 });
  if (!workspace.customerId) return NextResponse.json({ error: "This workspace has no Stripe customer yet." }, { status: 409 });
  const session = await stripe.billingPortal.sessions.create({ customer: workspace.customerId, return_url: publicUrl("/app/billing", request).toString() });
  return NextResponse.json({ url: session.url });
}
