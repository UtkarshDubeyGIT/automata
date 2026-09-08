"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
const NAV = [
  { href: "/app/workflows", label: "Automations", icon: "automations" },
  { href: "/app/workflows?tab=workflows", label: "Workflows", icon: "workflow" },
  { href: "/app/integrations", label: "Integrations", icon: "integrations" },
  { href: "/app/billing", label: "Billing", icon: "billing" },
  { href: "/app/settings", label: "Settings", icon: "settings" },
];
import { Icon } from "@/components/ui/icon";
import { ProgressBar } from "@/components/ui/feedback";
import { Logo } from "@/components/logo";
import { cn } from "@/lib/utils";
import { compactNumber } from "@/lib/utils";
import { useCredits } from "@/components/ui/credits";

export function Sidebar({
  planName: initialPlanName,
  planCredits: initialPlanCredits,
}: {
  planName?: string;
  planCredits?: number;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const workflowTab = searchParams.get("tab") ?? "create";
  /**
   * The live balance and plan, read from the same state every cost chip reads.
   *
   * This was a prop, resolved once in the server layout — and a layout is not
   * re-rendered by client navigation, so nothing a user did inside the app
   * ever moved the number. Spending was correct in the ledger and invisible on
   * screen: generate a 60-credit video, watch the meter sit still, conclude it
   * was free. The provider is seeded with the same server value, so first paint
   * is unchanged; it moves now because /api/credits is re-read after a charge.
   */
  const { credits, planName: livePlanName, planCredits: livePlanCredits } = useCredits();
  const planName = livePlanName || initialPlanName || "Starter";
  const planCredits = livePlanCredits || initialPlanCredits || 1000;

  /**
   * Runs blocked on a decision, surfaced on the Automations item.
   *
   * Approvals genuinely pause now, and a paused run is the one thing in the
   * product that no timer, retry or beat will ever move — it waits for a
   * person or it expires in 30 days. Before this it was discoverable only by
   * opening Automations and picking the right filter, which is not the same as
   * being told.
   */
  const [waiting, setWaiting] = useState(0);
  const loadWaiting = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows/waiting");
      if (!res.ok) return;
      const data = (await res.json()) as { waiting?: number };
      setWaiting(data.waiting ?? 0);
    } catch {
      // A badge that can't load is a badge that isn't shown. Never surface it.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await loadWaiting();
      if (!alive) return;
    })();
    // Re-check on navigation (approving something should clear it promptly)
    // and on a slow heartbeat for the case where a webhook or the beat parks a
    // run while the user is sitting on another screen.
    const id = window.setInterval(() => void loadWaiting(), 60_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [loadWaiting, pathname]);

  return (
    <aside className="flex h-full w-[72px] flex-none flex-col border-r border-line bg-card md:w-64">
      <div className="flex h-[72px] flex-none items-center justify-center md:justify-start md:px-6">
        <span className="hidden md:block"><Logo href="/app/workflows" /></span>
        <span className="md:hidden"><Logo href="/app/workflows" compact /></span>
      </div>

      <nav aria-label="Main navigation" className="scroll-thin flex-1 overflow-y-auto px-3 py-2">
        {NAV.map((item) => {
          const active = item.href === "/app/workflows?tab=workflows"
            ? pathname.startsWith("/app/workflows") && (pathname !== "/app/workflows" || workflowTab === "workflows")
            : item.href === "/app/workflows"
              ? pathname === "/app/workflows" && workflowTab !== "workflows"
              : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={active ? "page" : undefined}
              title={item.label}
              // Anchor for the first-run tour's "where the work lands" step.
              data-tour={`nav-${item.href.replace(/^\//, "") || "home"}`}
              className={cn(
                "mb-0.5 flex items-center justify-center gap-3 rounded-control px-3 py-2.5 md:justify-start text-[14px] font-medium transition-colors",
                active
                  ? "bg-brand-subtle text-brand"
                  : "text-ink-muted hover:bg-inset hover:text-ink",
              )}
            >
              <Icon name={item.icon} size={18} />
              <span className="hidden md:inline">{item.label}</span>
              {item.href === "/app/workflows" && waiting > 0 && (
                <span
                  title={`${waiting} run${waiting === 1 ? "" : "s"} waiting for your review`}
                  className="ml-auto inline-flex min-w-[20px] items-center justify-center rounded-full bg-brand px-1.5 py-0.5 text-[11px] font-semibold leading-none text-white"
                >
                  {waiting}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="hidden flex-none p-3 md:block">
        <div className="rounded-card border border-line bg-sunken p-4">
          <div className="flex items-center gap-2">
            <Icon name="sparkles" size={16} className="text-brand" />
            <span className="text-[13px] font-semibold text-ink">
              {planName}
            </span>
          </div>
          <div className="mt-3 flex items-baseline justify-between">
            <span className="text-[13px] text-ink-subtle">Credits</span>
            <span className="font-mono text-[15px] font-semibold tabular-nums text-ink">
              {compactNumber(credits)}
            </span>
          </div>
          <ProgressBar
            value={planCredits > 0 ? (credits / planCredits) * 100 : 0}
            tone="gradient"
            className="mt-2"
          />
        </div>
      </div>
    </aside>
  );
}
