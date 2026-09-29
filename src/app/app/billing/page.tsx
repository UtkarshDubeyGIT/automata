"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/app-shell/page-header";
import { Card, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { ProgressBar } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { BILLING_PLANS, PLANS } from "@/lib/billing/plans";
import type { DetailedSpend } from "@/lib/billing/spend";
import { useCredits } from "@/components/ui/credits";

interface HistoryItem {
  kind: "access" | "invoice";
  id: string;
  date: string;
  amount: string;
  status: string;
  plan: string;
  expiresAt?: string;
  url?: string;
}

interface BillingData {
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
  history: HistoryItem[];
  proAccess: { canRequest: boolean; requestStatus: "none" | "pending" | "delivery_failed"; courtesyExpiresAt: string | null };
}

export default function BillingPage() {
  const { toast } = useToast();
  const { credits, plan: livePlan, planName: livePlanName, planCredits: livePlanCredits, refresh: refreshCredits } = useCredits();
  const [busy, setBusy] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingData | null>(null);

  useEffect(() => {
    let alive = true;
    async function loadBilling() {
      try {
        void refreshCredits();
        const res = await fetch("/api/billing");
        if (!res.ok) return;
        const data = (await res.json()) as BillingData;
        if (alive) {
          setBilling(data);
        }
      } catch {
        // Degrades gracefully to useCredits values
      }
    }
    void loadBilling();
    return () => {
      alive = false;
    };
  }, [refreshCredits]);

  async function requestAccess() {
    setBusy("pro");
    try {
      const res = await fetch("/api/billing/pro-access/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.ok) {
        toast({ title: "Request submitted", description: "We’ll email you when your Pro access request is reviewed.", tone: "success" });
        const updated = await fetch("/api/billing", { cache: "no-store" });
        if (updated.ok) setBilling(await updated.json() as BillingData);
        return;
      }
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast({
        title: "Request could not be sent",
        description: err.error || "Please try again.",
        tone: "warning",
      });
    } catch {
      toast({ title: "Request could not be sent", description: "Please try again.", tone: "danger" });
    } finally {
      setBusy(null);
    }
  }

  const currentPlanId = billing?.plan || livePlan || PLANS.free.id;
  const currentPlanName = billing?.planName || livePlanName || PLANS.free.name;
  const currentPlanCredits = billing?.planCredits || livePlanCredits || PLANS.free.monthlyCredits;
  const isActive = billing?.status === "active";
  const renewalText =
    billing?.renewalText ||
    (livePlan === "pro" ? "Pro access" : "Free starter grant · Request Pro access for the full quota");
  const resetsInText = billing?.resetsInText || "One-time starter bonus";

  const spend: DetailedSpend = billing?.spend ?? { periodLabel: "Last 30 days", total: 0, refunded: 0, categories: [], workflows: [], standalone: [] };

  const history = billing?.history ?? [];
  const requestState = billing?.proAccess;
  const paidCurrentPro = billing?.plan === "pro" && billing.billingSource === "stripe";

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Billing" subtitle="Manage your plan and credits." />

      {/* Current plan + credits */}
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card className="p-6">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[18px] font-semibold text-ink">{currentPlanName}</h3>
                <Badge tone={isActive ? "brand" : "neutral"}>
                  {isActive ? "Active" : "Current"}
                </Badge>
              </div>
              <p className="mt-1 text-[14px] text-ink-subtle">
                {renewalText}
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-[26px] font-semibold text-ink tabular-nums">
                {credits.toLocaleString()}
              </div>
              <div className="text-[13px] text-ink-subtle">credits left</div>
            </div>
          </div>
          <ProgressBar
            value={currentPlanCredits > 0 ? (credits / currentPlanCredits) * 100 : 0}
            tone="gradient"
            className="mt-5"
          />
          <div className="mt-2 flex justify-between text-[13px] text-ink-subtle">
            <span>
              {credits.toLocaleString()} of {currentPlanCredits.toLocaleString()}
            </span>
            <span>{resetsInText}</span>
          </div>
        </Card>

        <Card className="p-6">
          <CardHeader
            title="Where your credits went"
            subtitle={spend.periodLabel}
            icon={<Icon name="activity" size={18} />}
          />
          <div className="mt-4 flex items-baseline justify-between text-[13px]">
            <span className="text-ink-subtle">Credits charged</span>
            <span className="font-mono text-ink tabular-nums">{spend.total.toLocaleString()}</span>
          </div>
          {spend.total > 0 ? (
            <div className="mt-4 flex flex-col gap-4">
              {spend.workflows.map((workflow) => (
                <div key={workflow.workflowId} className="border-t border-line pt-3 first:border-0 first:pt-0">
                  <div className="flex justify-between gap-4 text-[13px]">
                    <span className="font-medium text-ink">{workflow.name}</span>
                    <span className="font-mono font-medium text-ink tabular-nums">{workflow.credits.toLocaleString()} credits</span>
                  </div>
                  <ProgressBar
                    value={(workflow.credits / spend.total) * 100}
                    className="mt-1.5"
                  />
                  <p className="mt-1 text-[12px] text-ink-subtle">
                    {workflow.charges.map((charge) => `${charge.label} ${charge.credits.toLocaleString()}`).join(" · ")}
                  </p>
                </div>
              ))}
              {spend.standalone.length > 0 && (
                <div className="border-t border-line pt-3">
                  <div className="text-[13px] font-medium text-ink">Other activity</div>
                  {spend.standalone.map((charge) => (
                    <div key={charge.key} className="mt-1 flex justify-between gap-4 text-[12px] text-ink-subtle">
                      <span>{charge.label} · {charge.count}</span>
                      <span className="font-mono tabular-nums">{charge.credits.toLocaleString()} credits</span>
                    </div>
                  ))}
                </div>
              )}
              {spend.refunded > 0 && (
                <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px]">
                  <div className="flex justify-between text-ink-subtle">
                    <span>Refunded</span>
                    <span className="font-mono tabular-nums">-{spend.refunded.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between text-ink">
                    <span>Net spent</span>
                    <span className="font-mono tabular-nums">{Math.max(0, spend.total - spend.refunded).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="mt-4 text-[13px] text-ink-subtle">No credits spent yet in this period.</p>
          )}
        </Card>
      </div>

      {/* Plans */}
      <div>
        <h3 className="mb-3 text-[18px] font-semibold text-ink">Plans</h3>
          <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          {BILLING_PLANS.map((p) => {
            const isCurrent = p.id === currentPlanId;
            const paidPro = p.id === "pro" && paidCurrentPro;
            return (
              <Card
                key={p.id}
                className={cn(
                  "flex flex-col p-6",
                  p.highlighted && "border-brand-border ring-1 ring-[color:var(--brand-border)]",
                )}
              >
                <div className="flex items-center justify-between">
                  <h4 className="text-[17px] font-semibold text-ink">{p.name}</h4>
                  {p.highlighted && <Badge tone="brand">{paidPro ? "Paid plan" : "Invite only"}</Badge>}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="font-display text-[32px] font-semibold text-ink">
                    {p.id === "pro" && !paidPro ? "Complimentary" : `$${p.priceMonthly}`}
                  </span>
                  {p.id === "pro" && !paidPro ? null : <span className="text-[14px] text-ink-subtle">/mo</span>}
                </div>
                <div className="mt-1 font-mono text-[13px] text-brand">
                  {p.credits.toLocaleString()} {p.id === "free" ? "credits to start" : paidPro ? "credits / month" : "credits once with approval"}
                </div>
                {p.id === "pro" && !paidPro && <p className="mt-2 text-[12px] text-ink-subtle">30 days of Pro access. No payment is collected.</p>}
                <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                  {p.features.map((f, index) => (
                    <li key={f} className="flex items-start gap-2 text-[14px] text-ink-muted">
                      <Icon name="check" size={16} className="mt-0.5 flex-none text-success" />
                      {paidPro && index === 0 ? `${p.credits.toLocaleString()} credits / month` : f}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-6 w-full"
                  variant={isCurrent ? "secondary" : p.highlighted ? "primary" : "secondary"}
                  disabled={isCurrent || p.id === "free" || !requestState?.canRequest || requestState.requestStatus === "pending"}
                  loading={busy === p.id}
                  onClick={requestAccess}
                >
                  {isCurrent ? "Current plan" : p.id === "free" ? "Included by default"
                    : requestState?.requestStatus === "pending" ? "Request pending"
                    : requestState?.requestStatus === "delivery_failed" ? "Retry request email"
                    : !requestState?.canRequest ? "Ask a workspace admin" : "Request Pro access"}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Approved access and genuine paid invoices */}
      <Card className="p-6">
        <CardHeader title="Plan & access history" icon={<Icon name="database" size={18} />} />
        <div className="mt-4 overflow-x-auto">
          {history.length > 0 ? (
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-subtle">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Plan</th>
                  <th className="pb-2 font-medium">Access / charge</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {history.map((item) => (
                  <tr key={`${item.kind}:${item.id}`} className="border-b border-line last:border-0">
                    <td className="py-3 text-ink">{new Date(item.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</td>
                    <td className="py-3 text-ink-muted">{item.plan}</td>
                    <td className="py-3 text-ink">
                      {item.amount}
                      {item.kind === "access" && item.expiresAt && (
                        <div className="mt-0.5 text-[12px] text-ink-subtle">Access through {new Date(item.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</div>
                      )}
                    </td>
                    <td className="py-3">
                      <Badge tone={item.status === "Paid" || item.status === "Active" ? "success" : "neutral"} dot>
                        {item.status}
                      </Badge>
                    </td>
                    <td className="py-3 text-right">
                      {item.kind === "invoice" && item.url ? (
                        <a
                          href={item.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[13px] font-medium text-brand hover:underline"
                        >
                          Download
                        </a>
                      ) : (
                        <span className="text-[13px] text-ink-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="py-8 text-center text-[14px] text-ink-subtle">
              Approved Pro access and paid invoices will appear here.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
