import { NextResponse } from "next/server";
import { resolveRequestContext, getWorkspaceContext } from "@/lib/workspace";
import { getBalance } from "@/lib/credits";
import { normalizePlanId, planById } from "@/lib/billing/plans";
import { summarizeSpend, type SpendSummary } from "@/lib/billing/spend";
import { stripeClient } from "@/lib/billing/stripe";
import { supabaseConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export interface InvoiceItem {
  id: string;
  date: string;
  amount: string;
  status: string;
  plan: string;
  url?: string;
}

export interface BillingResponse {
  plan: string;
  planName: string;
  planCredits: number;
  priceMonthly: number;
  status: "active" | "inactive";
  currentPeriodEnd: string | null;
  renewalText: string;
  resetsInText: string;
  credits: number;
  spend: SpendSummary;
  invoices: InvoiceItem[];
  hasCustomerPortal: boolean;
}

export async function GET() {
  if (!supabaseConfigured) {
    const context = await getWorkspaceContext();
    const plan = planById(context.plan) ?? planById("free")!;
    return NextResponse.json({
      plan: plan.id,
      planName: plan.name,
      planCredits: plan.credits,
      priceMonthly: plan.priceMonthly,
      status: "inactive",
      currentPeriodEnd: null,
      renewalText: "Preview workspace",
      resetsInText: "Preview balance",
      credits: context.credits,
      spend: summarizeSpend([], "Last 30 days"),
      invoices: [],
      hasCustomerPortal: false,
      demo: true,
    });
  }

  const rc = await resolveRequestContext();
  if (!rc.workspaceId) return NextResponse.json({ error: "Sign in to view billing." }, { status: 401 });

  const db = rc.supabase;
  const workspaceId = rc.workspaceId;

  // 1. Resolve workspace and billing_customer
  let planId = "free";
  let status: "active" | "inactive" = "inactive";
  let currentPeriodEnd: string | null = null;
  let stripeCustomerId: string | null = null;

  if (db) {
    const [wsRes, bcRes] = await Promise.all([
      db.from("workspaces").select("plan").eq("id", workspaceId).maybeSingle(),
      db.from("billing_customers")
        .select("plan, status, current_period_end, stripe_customer_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
    ]);

    planId = wsRes.data?.plan || bcRes.data?.plan || "free";
    status = bcRes.data?.status === "active" ? "active" : "inactive";
    currentPeriodEnd = bcRes.data?.current_period_end ?? null;
    stripeCustomerId = bcRes.data?.stripe_customer_id ?? null;
  }

  const planObj = planById(planId) ?? planById("free")!;
  planId = normalizePlanId(planId);
  const planName = planObj.name;
  const planCredits = planObj.credits;
  const priceMonthly = planObj.priceMonthly;

  // 2. Resolve live credits
  const credits = await getBalance(workspaceId);

  // 3. Compute cycle text
  let renewalText = "No active recurring subscription";
  let resetsInText = "One-time starter bonus";

  if (status === "active" && currentPeriodEnd) {
    const endDate = new Date(currentPeriodEnd);
    const now = new Date();
    const diffMs = endDate.getTime() - now.getTime();
    const daysLeft = Math.max(0, Math.ceil(diffMs / 86_400_000));
    renewalText = `renews ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    resetsInText = `Resets in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`;
  } else if (status === "active") {
    renewalText = "renews monthly";
    resetsInText = "Resets each billing cycle";
  }

  // 4. Credits actually debited this period, grouped by what they bought.
  const cycleEnd = status === "active" && currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  const cycleStart = new Date((cycleEnd ?? new Date()).getTime() - 30 * 86_400_000).toISOString();

  let ledgerRows: { reason: string; delta: number }[] = [];
  if (db) {
    const { data } = await db
      .from("credit_ledger")
      .select("reason, delta")
      .eq("workspace_id", workspaceId)
      .gte("created_at", cycleStart);
    ledgerRows = data ?? [];
  }
  const spend = summarizeSpend(ledgerRows, cycleEnd ? "This billing cycle" : "Last 30 days");

  // 5. Invoices
  const invoices: InvoiceItem[] = [];
  const stripe = stripeClient();
  if (stripe && stripeCustomerId) {
    try {
      const stripeInvoices = await stripe.invoices.list({
        customer: stripeCustomerId,
        limit: 10,
      });
      for (const inv of stripeInvoices.data) {
        invoices.push({
          id: inv.id,
          date: new Date((inv.created ?? 0) * 1000).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
          amount: `$${((inv.amount_paid ?? 0) / 100).toFixed(2)}`,
          status:
            inv.status === "paid"
              ? "Paid"
              : inv.status
                ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1)
                : "Pending",
          plan: planName,
          url: inv.hosted_invoice_url ?? inv.invoice_pdf ?? undefined,
        });
      }
    } catch {
      // In case of network / Stripe error, degrade gracefully to empty list
    }
  }

  return NextResponse.json({
    plan: planId,
    planName,
    planCredits,
    priceMonthly,
    status,
    currentPeriodEnd,
    renewalText,
    resetsInText,
    credits,
    spend,
    invoices,
    hasCustomerPortal: Boolean(stripe && stripeCustomerId),
    demo: false,
  });
}
