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
import type { SpendSummary } from "@/lib/billing/spend";
import { useCredits } from "@/components/ui/credits";

interface InvoiceItem {
  id: string;
  date: string;
  amount: string;
  status: string;
  plan: string;
  url?: string;
}

interface BillingData {
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

export default function BillingPage() {
  const { toast } = useToast();
  const { credits, plan: livePlan, planName: livePlanName, planCredits: livePlanCredits, refresh: refreshCredits } = useCredits();
  const [busy, setBusy] = useState<string | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
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

  async function openCustomerPortal() {
    setPortalBusy(true);
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      if (res.ok) {
        const { url } = (await res.json()) as { url?: string };
        if (url) {
          window.location.href = url;
          return;
        }
      }
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast({
        title: "Customer portal unavailable",
        description:
          err.error || "No active Stripe customer subscription is configured.",
        tone: "warning",
      });
    } catch {
      toast({
        title: "Customer portal error",
        description: "Failed to reach customer billing portal.",
        tone: "danger",
      });
    } finally {
      setPortalBusy(false);
    }
  }

  async function upgrade(planId: string) {
    setBusy(planId);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId }),
      });
      if (res.ok) {
        const { url } = (await res.json()) as { url?: string };
        if (url) {
          window.location.href = url;
          return;
        }
      }
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast({
        title: "Checkout unavailable",
        description:
          err.error || "Add your Stripe keys + price ids to enable live billing.",
        tone: "warning",
      });
    } finally {
      setBusy(null);
    }
  }

  const currentPlanId = billing?.plan || livePlan || PLANS.free.id;
  const currentPlanName = billing?.planName || livePlanName || PLANS.free.name;
  const currentPlanCredits = billing?.planCredits || livePlanCredits || PLANS.free.monthlyCredits;
  const currentPriceMonthly = billing?.priceMonthly ?? PLANS.free.monthlyPrice;
  const isActive = billing?.status === "active";
  const renewalText =
    billing?.renewalText ||
    (isActive ? `$${currentPriceMonthly}/mo · renews monthly` : "Free starter grant · Upgrade to unlock full quota");
  const resetsInText = billing?.resetsInText || "One-time starter bonus";

  const spend: SpendSummary = billing?.spend ?? { periodLabel: "Last 30 days", total: 0, refunded: 0, categories: [] };

  const invoices = billing?.invoices ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Billing"
        subtitle="Manage your plan and credits."
        action={
          <Button
            variant="secondary"
            icon="external-link"
            loading={portalBusy}
            onClick={openCustomerPortal}
          >
            Manage subscription
          </Button>
        }
      />

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
          {spend.categories.length > 0 ? (
            <div className="mt-4 flex flex-col gap-4">
              {spend.categories.map((c) => (
                <div key={c.key}>
                  <div className="flex justify-between text-[13px]">
                    <span className="text-ink">
                      {c.label}
                      <span className="ml-1.5 text-ink-subtle">· {c.count}</span>
                    </span>
                    <span className="font-mono text-ink-subtle tabular-nums">{c.credits.toLocaleString()}</span>
                  </div>
                  <ProgressBar
                    value={spend.total > 0 ? (c.credits / spend.total) * 100 : 0}
                    className="mt-1.5"
                  />
                </div>
              ))}
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
                  {p.highlighted && <Badge tone="brand">Popular</Badge>}
                </div>
                <div className="mt-3 flex items-baseline gap-1">
                  <span className="font-display text-[32px] font-semibold text-ink">
                    ${p.priceMonthly}
                  </span>
                  <span className="text-[14px] text-ink-subtle">/mo</span>
                </div>
                <div className="mt-1 font-mono text-[13px] text-brand">
                  {p.credits.toLocaleString()} {p.id === "free" ? "credits to start" : "credits / mo"}
                </div>
                <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                  {p.features.map((f) => (
                    <li key={f} className="flex items-start gap-2 text-[14px] text-ink-muted">
                      <Icon name="check" size={16} className="mt-0.5 flex-none text-success" />
                      {f}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-6 w-full"
                  variant={isCurrent ? "secondary" : p.highlighted ? "primary" : "secondary"}
                  disabled={isCurrent || p.id === "free"}
                  loading={busy === p.id}
                  onClick={() => upgrade(p.id)}
                >
                  {isCurrent ? "Current plan" : p.id === "free" ? "Included by default" : `Switch to ${p.name}`}
                </Button>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Invoices */}
      <Card className="p-6">
        <CardHeader title="Invoice history" icon={<Icon name="database" size={18} />} />
        <div className="mt-4 overflow-x-auto">
          {invoices.length > 0 ? (
            <table className="w-full text-[14px]">
              <thead>
                <tr className="border-b border-line text-left text-ink-subtle">
                  <th className="pb-2 font-medium">Date</th>
                  <th className="pb-2 font-medium">Plan</th>
                  <th className="pb-2 font-medium">Amount</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-line last:border-0">
                    <td className="py-3 text-ink">{inv.date}</td>
                    <td className="py-3 text-ink-muted">{inv.plan}</td>
                    <td className="py-3 font-mono text-ink">{inv.amount}</td>
                    <td className="py-3">
                      <Badge tone={inv.status === "Paid" ? "success" : "neutral"} dot>
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="py-3 text-right">
                      {inv.url ? (
                        <a
                          href={inv.url}
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
              No invoice history yet. Invoices from paid subscriptions will appear here.
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
