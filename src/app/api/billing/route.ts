import { NextResponse } from "next/server";
import { resolveRequestContext, getWorkspaceContext } from "@/lib/workspace";
import { getBalance } from "@/lib/credits";
import { planById } from "@/lib/billing/plans";
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

export interface UsageMetric {
  label: string;
  used: number;
  of: number;
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
  usage: UsageMetric[];
  invoices: InvoiceItem[];
  hasCustomerPortal: boolean;
}

export async function GET() {
  if (!supabaseConfigured) {
    const context = await getWorkspaceContext();
    const plan = planById(context.plan) ?? planById("free")!;
    return NextResponse.json({
      plan: context.plan,
      planName: plan.name,
      planCredits: plan.credits,
      priceMonthly: plan.priceMonthly,
      status: "inactive",
      currentPeriodEnd: null,
      renewalText: "Preview workspace",
      resetsInText: "Preview balance",
      credits: context.credits,
      usage: [],
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

  // 4. Compute real cycle usage
  const cycleStart = currentPeriodEnd
    ? new Date(new Date(currentPeriodEnd).getTime() - 30 * 86_400_000).toISOString()
    : new Date(Date.now() - 30 * 86_400_000).toISOString();

  let contentCount = 0;
  let videoCount = 0;
  let scansCount = 0;

  if (db) {
    const [contentRes, videoRes, scansRes] = await Promise.all([
      db.from("content_items")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .gte("created_at", cycleStart),
      db.from("videos")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .gte("created_at", cycleStart),
      db.from("credit_ledger")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("reason", ["viral_angle", "viral_query", "analytics_query", "trend_refresh"])
        .gte("created_at", cycleStart),
    ]);
    contentCount = contentRes.count ?? 0;
    videoCount = videoRes.count ?? 0;
    scansCount = scansRes.count ?? 0;
  }

  // Plan limits representation
  const limits: Record<string, { content: number; video: number; scans: number }> = {
    starter: { content: 300, video: 10, scans: 100 },
    growth: { content: 1000, video: 40, scans: 300 },
    scale: { content: 4000, video: 150, scans: 1000 },
  };
  const planLimits = limits[planId] ?? limits.starter;

  const usage: UsageMetric[] = [
    { label: "Content generations", used: contentCount, of: planLimits.content },
    { label: "Video renders", used: videoCount, of: planLimits.video },
    { label: "Viral angle scans", used: scansCount, of: planLimits.scans },
  ];

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
    usage,
    invoices,
    hasCustomerPortal: Boolean(stripe && stripeCustomerId),
    demo: false,
  });
}
