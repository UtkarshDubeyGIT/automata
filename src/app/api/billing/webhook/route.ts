import type Stripe from "stripe";
import { NextResponse, type NextRequest } from "next/server";

import { planForPrice, stripeClient } from "@/lib/billing/stripe";
import { PLANS, type PlanId } from "@/lib/billing/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

function id(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

export async function POST(request: NextRequest) {
  const stripe = stripeClient();
  const admin = createSupabaseAdminClient();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !admin || !secret) return NextResponse.json({ error: "Billing webhook is not configured." }, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return NextResponse.json({ error: "Missing Stripe signature." }, { status: 400 });
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(await request.text(), signature, secret);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid Stripe signature." }, { status: 400 });
  }
  const { data: seen } = await admin.from("billing_events").select("id").eq("id", event.id).maybeSingle();
  if (seen) return NextResponse.json({ received: true, replayed: true });

  let workspaceId: string | null = null;
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    workspaceId = session.client_reference_id ?? session.metadata?.workspace_id ?? null;
    if (workspaceId) await admin.from("workspaces").update({ stripe_customer_id: id(session.customer), stripe_subscription_id: id(session.subscription), subscription_status: "active", plan: (session.metadata?.plan as PlanId) ?? "pro" }).eq("id", workspaceId);
  } else if (event.type.startsWith("customer.subscription.")) {
    const subscription = event.data.object as Stripe.Subscription;
    workspaceId = subscription.metadata.workspace_id ?? null;
    const plan = planForPrice(subscription.items.data[0]?.price.id) ?? (subscription.metadata.plan as PlanId | undefined) ?? "free";
    const active = new Set(["active", "trialing", "past_due"]).has(subscription.status);
    if (workspaceId) await admin.from("workspaces").update({ stripe_customer_id: id(subscription.customer), stripe_subscription_id: subscription.id, subscription_status: subscription.status, plan: active ? plan : "free", credits_remaining: active ? PLANS[plan].monthlyCredits : PLANS.free.monthlyCredits }).eq("id", workspaceId);
  }

  const { error } = await admin.from("billing_events").insert({ id: event.id, event_type: event.type, workspace_id: workspaceId });
  if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ received: true });
}
