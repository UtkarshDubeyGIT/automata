import { NextResponse } from "next/server";
import { resolveRequestContext, getWorkspaceContext } from "@/lib/workspace";
import { getBalance } from "@/lib/credits";
import { normalizePlanId, planById } from "@/lib/billing/plans";
import { runIdsForCharges, summarizeDetailedSpend, type DetailedSpend, type LedgerSpendRow } from "@/lib/billing/spend";
import { billingWorkspace } from "@/lib/billing/workspace";
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

export type HistoryItem =
  | { kind: "access"; id: string; date: string; expiresAt: string; status: string; plan: "Pro"; amount: "Complimentary · $0 charged" }
  | { kind: "invoice"; id: string; date: string; status: string; plan: string; amount: string; url?: string };

export interface ProAccessState {
  canRequest: boolean;
  requestStatus: "none" | "pending" | "delivery_failed";
  courtesyExpiresAt: string | null;
}

export interface BillingResponse {
  billingSource: "free" | "courtesy" | "stripe" | "preview";
  plan: string;
  planName: string;
  planCredits: number;
  priceMonthly: number;
  status: "active" | "inactive";
  currentPeriodEnd: string | null;
  renewalText: string;
  resetsInText: string;
  credits: number;
  spend: DetailedSpend;
  invoices: InvoiceItem[];
  history: HistoryItem[];
  proAccess: ProAccessState;
}

export async function GET() {
  if (!supabaseConfigured) {
    const context = await getWorkspaceContext();
    const plan = planById(context.plan) ?? planById("free")!;
    return NextResponse.json({
      plan: plan.id,
      billingSource: "preview",
      planName: plan.name,
      planCredits: plan.credits,
      priceMonthly: plan.priceMonthly,
      status: "inactive",
      currentPeriodEnd: null,
      renewalText: "Preview workspace",
      resetsInText: "Preview balance",
      credits: context.credits,
      spend: summarizeDetailedSpend([], "Last 30 days", new Map(), new Map()),
      invoices: [],
      history: [],
      proAccess: { canRequest: false, requestStatus: "none", courtesyExpiresAt: null },
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
  let subscriptionStatus = "inactive";
  let courtesyExpiresAt: string | null = null;
  let requestStatus: ProAccessState["requestStatus"] = "none";
  let accessHistory: HistoryItem[] = [];
  let canRequest = false;

  if (db) {
    const [wsRes, bcRes, accessRes, billingOwner] = await Promise.all([
      db.from("workspaces").select("plan,subscription_status").eq("id", workspaceId).maybeSingle(),
      db.from("billing_customers")
        .select("plan, status, current_period_end, stripe_customer_id")
        .eq("workspace_id", workspaceId)
        .maybeSingle(),
      db.from("pro_access_requests")
        .select("id,status,email_status,requested_at,link_expires_at,decided_at,access_expires_at,expired_at")
        .eq("workspace_id", workspaceId).order("requested_at", { ascending: false }),
      rc.userId ? billingWorkspace(db, rc.userId, workspaceId) : Promise.resolve(null),
    ]);

    if (wsRes.error || bcRes.error || accessRes.error) return NextResponse.json({ error: "Could not load billing history." }, { status: 502 });

    planId = wsRes.data?.plan || bcRes.data?.plan || "free";
    subscriptionStatus = wsRes.data?.subscription_status ?? bcRes.data?.status ?? "inactive";
    status = subscriptionStatus === "active" || subscriptionStatus === "invite_active" ? "active" : "inactive";
    currentPeriodEnd = bcRes.data?.current_period_end ?? null;
    stripeCustomerId = bcRes.data?.stripe_customer_id ?? null;
    canRequest = Boolean(billingOwner);
    const accessRows = accessRes.data ?? [];
    const pending = accessRows.find((row) => row.status === "pending");
    requestStatus = pending
      ? pending.email_status === "failed" || new Date(pending.link_expires_at).getTime() <= Date.now() ||
        (pending.email_status === "pending" && new Date(pending.requested_at).getTime() <= Date.now() - 60_000)
        ? "delivery_failed" : "pending"
      : "none";
    const activeGrant = accessRows.find((row) => row.status === "approved" && row.access_expires_at && !row.expired_at && new Date(row.access_expires_at).getTime() > Date.now());
    const latestGrant = accessRows.find((row) => row.status === "approved" && row.access_expires_at);
    if (subscriptionStatus === "invite_active") {
      courtesyExpiresAt = latestGrant?.access_expires_at ?? null;
      if (!activeGrant) status = "inactive";
    }
    accessHistory = accessRows.filter((row) => row.status === "approved" && row.decided_at && row.access_expires_at)
      .map((row) => ({
        kind: "access" as const, id: row.id, date: row.decided_at!, expiresAt: row.access_expires_at!,
        status: subscriptionStatus === "invite_active" && activeGrant?.id === row.id ? "Active"
          : new Date(row.access_expires_at!).getTime() <= Date.now() ? "Expired" : "Ended",
        plan: "Pro" as const, amount: "Complimentary · $0 charged" as const,
      }));
  }

  const planObj = planById(planId) ?? planById("free")!;
  planId = normalizePlanId(planId);
  const billingSource = subscriptionStatus === "invite_active" ? "courtesy" : planId === "pro" ? "stripe" : "free";
  const planName = planObj.name;
  const planCredits = planObj.credits;
  const priceMonthly = planObj.priceMonthly;

  // 2. Resolve live credits
  const credits = await getBalance(workspaceId);

  // 3. Compute cycle text
  let renewalText = "No active recurring subscription";
  let resetsInText = "One-time starter bonus";

  if (courtesyExpiresAt) {
    const endDate = new Date(courtesyExpiresAt);
    renewalText = `Complimentary Pro access ${endDate.getTime() > Date.now() ? "ends" : "ended"} ${endDate.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    resetsInText = "One-time 10,000-credit grant";
  } else if (status === "active" && currentPeriodEnd) {
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
  const cycleEnd = status === "active" && !courtesyExpiresAt && currentPeriodEnd ? new Date(currentPeriodEnd) : null;
  const cycleStart = new Date((cycleEnd ?? new Date()).getTime() - 30 * 86_400_000).toISOString();

  const ledgerRows: LedgerSpendRow[] = [];
  if (db) {
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await db.from("credit_ledger")
        .select("reason,delta,ref,idem_key")
        .eq("workspace_id", workspaceId).gte("created_at", cycleStart)
        .order("id", { ascending: true }).range(offset, offset + 999);
      if (error) return NextResponse.json({ error: "Could not load credit usage." }, { status: 502 });
      ledgerRows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
  }
  const runWorkflowIds = new Map<string, string>();
  const workflowNames = new Map<string, string>();
  if (db) {
    const runIds = runIdsForCharges(ledgerRows);
    // Workflow runs are cascaded when an automation is deleted, but the run
    // charge keeps both the run ID (in idem_key) and workflow ID (in ref).
    // Preserve that durable link so image/video charges from the same run are
    // still grouped under "Deleted automation" instead of standalone usage.
    for (const row of ledgerRows) {
      const parts = row.idem_key?.split(":");
      if (row.reason === "workflow_run" && row.ref && parts?.[0] === "workflow_run" && parts[1]) {
        runWorkflowIds.set(parts[1], row.ref);
      }
    }
    for (let i = 0; i < runIds.length; i += 200) {
      const { data, error } = await db.from("workflow_runs").select("id,workflow_id")
        .eq("workspace_id", workspaceId).in("id", runIds.slice(i, i + 200));
      if (error) return NextResponse.json({ error: "Could not attribute credit usage." }, { status: 502 });
      for (const run of data ?? []) {
        if (!runWorkflowIds.has(run.id)) runWorkflowIds.set(run.id, run.workflow_id);
      }
    }
    const workflowIds = [...new Set([
      ...ledgerRows.filter((row) => row.reason === "workflow_run" && row.ref).map((row) => row.ref!),
      ...runWorkflowIds.values(),
    ])];
    for (let i = 0; i < workflowIds.length; i += 200) {
      const { data, error } = await db.from("workflows").select("id,name")
        .eq("workspace_id", workspaceId).in("id", workflowIds.slice(i, i + 200));
      if (error) return NextResponse.json({ error: "Could not load automation names." }, { status: 502 });
      for (const workflow of data ?? []) workflowNames.set(workflow.id, workflow.name);
    }
  }
  const spend = summarizeDetailedSpend(ledgerRows, cycleEnd ? "This billing cycle" : "Last 30 days", workflowNames, runWorkflowIds);

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
          date: new Date((inv.created ?? 0) * 1000).toISOString(),
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

  const history: HistoryItem[] = [
    ...accessHistory,
    ...invoices.map((invoice) => ({ kind: "invoice" as const, ...invoice })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  return NextResponse.json({
    plan: planId,
    billingSource,
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
    history,
    proAccess: { canRequest, requestStatus, courtesyExpiresAt },
    hasCustomerPortal: false,
    demo: false,
  });
}
