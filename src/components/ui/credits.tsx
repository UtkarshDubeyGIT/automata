"use client";

import * as React from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * Price transparency, in one place.
 *
 * Every screen that spends credits has to answer the same three questions
 * before the user commits: what does this cost, can I afford it, and what am I
 * left with. They used to answer them separately and inconsistently — the Video
 * page hardcoded "80 credits" next to a route that charged per format, Content
 * Studio quoted images from a local constant and text generation quoted nothing
 * at all. A price the product states and a price it charges must come from the
 * same place, so both come from /api/credits.
 */

export type BillableReason =
  | "content_variation"
  | "image_generation"
  | "video_ugc"
  | "video_shortform"
  | "video_cinematic"
  | "video_avatar"
  | "video_demo"
  | "viral_angle"
  | "viral_query"
  | "analytics_query"
  | "trend_refresh"
  | "brand_research"
  | "workflow_run"
  | "workflow_build"
  | "goal_plan";

interface Price {
  reason: BillableReason;
  label: string;
  credits: number;
}

interface CreditsState {
  credits: number;
  prices: Record<string, number>;
  loading: boolean;
  /** Price of an action, times however many units it produces. */
  quote: (reason: BillableReason, quantity?: number) => number;
  /** Can this workspace afford it right now? */
  affords: (reason: BillableReason, quantity?: number) => boolean;
  /** Re-read after spending. */
  refresh: () => Promise<void>;
}

const CreditsContext = React.createContext<CreditsState | null>(null);

/**
 * Reads balance + price book once and shares them. Mounted in the app shell so
 * every authenticated screen has prices without its own fetch — and, more
 * importantly, so the sidebar meter and an in-page cost chip can never show
 * numbers from two different reads.
 */
export function CreditsProvider({
  initialCredits = 0,
  children,
}: {
  initialCredits?: number;
  children: React.ReactNode;
}) {
  const [credits, setCredits] = React.useState(initialCredits);
  const [prices, setPrices] = React.useState<Record<string, number>>({});
  const [loading, setLoading] = React.useState(true);

  const read = React.useCallback(async (): Promise<{
    credits: number;
    prices: Record<string, number>;
  } | null> => {
    try {
      const res = await fetch("/api/credits");
      if (!res.ok) return null;
      const data = (await res.json()) as { credits?: number; prices?: Price[] };
      const map: Record<string, number> = {};
      for (const p of data.prices ?? []) map[p.reason] = p.credits;
      return { credits: data.credits ?? 0, prices: map };
    } catch {
      return null;
    }
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void read().then((next) => {
      if (cancelled) return;
      if (next) {
        setCredits(next.credits);
        setPrices(next.prices);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [read]);

  const refresh = React.useCallback(async () => {
    const next = await read();
    if (next) {
      setCredits(next.credits);
      setPrices(next.prices);
    }
  }, [read]);

  const value = React.useMemo<CreditsState>(() => {
    const quote = (reason: BillableReason, quantity = 1) =>
      (prices[reason] ?? 0) * Math.max(1, Math.round(quantity));
    return {
      credits,
      prices,
      loading,
      quote,
      affords: (reason, quantity = 1) => {
        const cost = quote(reason, quantity);
        // Unknown price (still loading, or a reason the server doesn't bill)
        // must not block the button — failing closed here would make the whole
        // app look broken for the second it takes to fetch.
        return cost === 0 || credits >= cost;
      },
      refresh,
    };
  }, [credits, prices, loading, refresh]);

  return <CreditsContext.Provider value={value}>{children}</CreditsContext.Provider>;
}

export function useCredits(): CreditsState {
  const ctx = React.useContext(CreditsContext);
  if (ctx) return ctx;
  // Outside the provider (a preview render, a story) the hook still works and
  // simply prices nothing, rather than throwing and taking the screen with it.
  return {
    credits: 0,
    prices: {},
    loading: true,
    quote: () => 0,
    affords: () => true,
    refresh: async () => {},
  };
}

/**
 * The cost of the action, stated before it runs. Turns amber when the user
 * cannot afford it and links to Billing — the moment someone is blocked is the
 * moment to show them the way to unblock, not a dead-end error.
 */
export function CostChip({
  reason,
  quantity = 1,
  amount,
  className,
}: {
  reason: BillableReason;
  quantity?: number;
/**
 * An exact price this chip must show, overriding `reason` × `quantity`.
 *
 * For actions whose cost is not a whole multiple of a listed price — video,
 * where length scales the charge — the caller works the number out with the
 * same shared function the server bills from and hands it here. `reason` is
 * still required: it is what decides whether the balance falls short.
 */
  amount?: number;
  className?: string;
}) {
  const { quote, credits, loading } = useCredits();
  const quoted = quote(reason, quantity);
  // An override of 0 is still an override; only `undefined` means "not given".
  // Falling back on falsiness would have made a free action quote a full price.
  const cost = amount ?? quoted;
  if (loading || cost === 0) return null;
  const short = credits < cost;

  const body = (
    <>
      <Icon name="zap" size={12} className={short ? "text-warning" : "text-brand"} />
      <span className="font-mono tabular-nums">{cost}</span>
      <span>{cost === 1 ? "credit" : "credits"}</span>
      {short && <span className="font-medium">· top up</span>}
    </>
  );

  const base = cn(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px]",
    short
      ? "border-warning-border bg-warning-surface text-warning"
      : "border-line bg-inset text-ink-muted",
    className,
  );

  return short ? (
    <Link href="/billing" className={cn(base, "transition-colors hover:border-warning")}>
      {body}
    </Link>
  ) : (
    <span className={base}>{body}</span>
  );
}

/**
 * Inline "· 3 credits" for use inside a button label, where a bordered chip
 * would be too heavy.
 */
export function CostSuffix({
  reason,
  quantity = 1,
  amount,
}: {
  reason: BillableReason;
  quantity?: number;
  /** Exact price override — see CostChip. */
  amount?: number;
}) {
  const { quote, loading } = useCredits();
  const cost = amount ?? quote(reason, quantity);
  if (loading || cost === 0) return null;
  return <span className="opacity-75"> · {cost} credits</span>;
}
