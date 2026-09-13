import type Stripe from "stripe";
import { NextResponse, type NextRequest } from "next/server";

import { planForPrice, stripeClient } from "@/lib/billing/stripe";
import { isPlanId, planById } from "@/lib/billing/plans";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { grantCredits } from "@/lib/credits";

function id(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

type BillingDb = NonNullable<ReturnType<typeof createSupabaseAdminClient>>;

async function saveSubscription(
  db: BillingDb,
  workspaceId: string,
  fields: { plan: string; status: string; stripe_customer_id: string | null; stripe_subscription_id: string | null; current_period_end?: string | null },
) {
  const { error } = await db.from("billing_customers").upsert({ workspace_id: workspaceId, ...fields }, { onConflict: "workspace_id" });
  if (error) throw new Error(error.message);

  // workspaces.plan is the strict `plan_id` enum (free/pro/team).
  // billing_customers.plan (just written above) is plain text and can carry
  // a legacy Zidane label (starter/growth/scale) for display — but writing
  // that same label to the enum column throws 22P02. Leave the enum column
  // untouched rather than crash the webhook into a permanent Stripe retry
  // loop; the caller's own "free" fallback still governs anything else here.
  const workspaceFields: Record<string, unknown> = {
    subscription_status: fields.status,
    stripe_customer_id: fields.stripe_customer_id,
    stripe_subscription_id: fields.stripe_subscription_id,
  };
  if (isPlanId(fields.plan)) workspaceFields.plan = fields.plan;

  const { error: workspaceError } = await db.from("workspaces").update(workspaceFields).eq("id", workspaceId);
  if (!workspaceError) return;
  // Original Zidane workspaces store subscription fields in billing_customers.
  if (workspaceError.code !== "42703" && workspaceError.code !== "PGRST204") throw new Error(workspaceError.message);
  if (!isPlanId(fields.plan)) return;
  const { error: planError } = await db.from("workspaces").update({ plan: fields.plan }).eq("id", workspaceId);
  if (planError) throw new Error(planError.message);
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
  const { data: seen, error: readError } = await admin.from("billing_events").select("id").eq("id", event.id).maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not read billing delivery status." }, { status: 500 });
  if (seen) return NextResponse.json({ received: true, replayed: true });

  let workspaceId: string | null = null;
  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      workspaceId = session.client_reference_id ?? session.metadata?.workspace_id ?? session.metadata?.workspaceId ?? null;
      const requestedPlan = session.metadata?.plan ?? session.metadata?.planId ?? "pro";
      const plan = planById(requestedPlan);
      if (workspaceId && plan) await saveSubscription(admin, workspaceId, {
        stripe_customer_id: id(session.customer), stripe_subscription_id: id(session.subscription), status: "active", plan: plan.id,
      });
    } else if (event.type.startsWith("customer.subscription.")) {
      const subscription = event.data.object as Stripe.Subscription;
      workspaceId = subscription.metadata.workspace_id ?? subscription.metadata.workspaceId ?? null;
      const requestedPlan = planForPrice(subscription.items.data[0]?.price.id) ?? subscription.metadata.plan ?? subscription.metadata.planId ?? "free";
      const plan = planById(requestedPlan)?.id ?? "free";
      const active = new Set(["active", "trialing", "past_due"]).has(subscription.status);
      const periodEnd = subscription.items.data[0]?.current_period_end;
      if (workspaceId) await saveSubscription(admin, workspaceId, {
        stripe_customer_id: id(subscription.customer), stripe_subscription_id: subscription.id,
        status: subscription.status, plan: active ? plan : "free",
        current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
      });
    } else if (event.type === "invoice.paid") {
      const invoice = event.data.object as Stripe.Invoice;
      // Plan grants are earned by a paid initial/renewal invoice. Subscription
      // edits and upgrade prorations must not mint a second monthly allowance.
      if (invoice.billing_reason === "subscription_create" || invoice.billing_reason === "subscription_cycle") {
        const metadata = invoice.parent?.subscription_details?.metadata;
        const { data: billing, error } = await admin.from("billing_customers")
          .select("workspace_id,plan").eq("stripe_customer_id", id(invoice.customer) ?? "").maybeSingle();
        if (error) throw new Error(error.message);
        workspaceId = metadata?.workspace_id ?? metadata?.workspaceId ?? billing?.workspace_id ?? null;
        // Portal upgrades change the billed price without rewriting checkout
        // metadata. The paid line is authoritative even when subscription and
        // invoice webhooks arrive out of order.
        const invoicedPlan = invoice.lines?.data.map((line) => {
          const legacyPrice = (line as unknown as { price?: string | { id: string } }).price;
          return planForPrice(id(line.pricing?.price_details?.price ?? legacyPrice ?? null));
        }).find((candidate) => candidate !== null);
        const plan = planById(invoicedPlan ?? billing?.plan ?? metadata?.plan ?? metadata?.planId ?? "");
        if (!workspaceId || !plan) throw new Error("The subscription invoice is waiting for its workspace mapping.");
        await grantCredits(workspaceId, plan.credits, "plan_grant", invoice.id, `stripe-invoice:${invoice.id}`);
      }
    }

    const { error } = await admin.from("billing_events").insert({ id: event.id, event_type: event.type, workspace_id: workspaceId });
    if (error && error.code !== "23505") throw new Error(error.message);
    return NextResponse.json({ received: true });
  } catch (error) {
    console.error("[billing] webhook processing failed", error);
    return NextResponse.json({ error: "Could not finish updating billing. This delivery can be retried." }, { status: 500 });
  }
}
