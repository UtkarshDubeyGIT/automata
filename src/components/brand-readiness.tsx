"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import type { BrandReadiness } from "@/lib/brand";

/**
 * "Do we know enough about this business to write for it?" — asked in the
 * browser, by every place an automation is created.
 *
 * The answer already existed, but only inside `GET /api/workflows/[id]`, so it
 * could not be asked until the automation had been saved. That is the wrong
 * moment: by then the user has described what they want, watched it be built,
 * and been given no reason to expect the output to be about anyone in
 * particular. `GET /api/brand/readiness` is the same answer without needing an
 * id, and this hook is the shared client for it — deliberately mirroring
 * `useAppConnections`, since the two notices sit next to each other and are
 * answering the same class of question.
 *
 * Non-blocking by construction: a request that fails leaves `readiness` null
 * and every consumer renders nothing. Nagging someone because a fetch failed
 * is worse than staying quiet.
 */
export function useBrandReadiness() {
  const [readiness, setReadiness] = useState<BrandReadiness | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/brand/readiness");
      if (!res.ok) return;
      const data = (await res.json().catch(() => null)) as
        | { readiness?: BrandReadiness; unknown?: boolean }
        | null;
      // `unknown` means our own read failed, not that the profile is empty.
      if (alive.current && data?.readiness && !data.unknown) setReadiness(data.readiness);
    } catch {
      // Silence — see above.
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
    })();
  }, [refresh]);

  return { readiness, refresh };
}

/**
 * The notice itself. Renders nothing unless the graph in front of the user
 * generates something AND we have positively established that we cannot say
 * what the business is — so it is silent while loading, silent on error, and
 * silent for a workspace that filled its profile in.
 */
export function BrandGap({
  readiness,
  needed,
  className,
}: {
  readiness: BrandReadiness | null;
  /** Does this graph write copy or make an image? (`needsBrandGrounding`) */
  needed: boolean;
  className?: string;
}) {
  if (!needed || !readiness || readiness.knowsProduct) return null;
  return (
    <div
      className={
        className ??
        "flex min-w-0 items-center gap-2 border-b border-warning-border/70 py-2 text-[12px] leading-snug"
      }
      data-brand-notice
    >
      <Icon name="sparkles" size={13} className="flex-none text-warning" />
      <div className="min-w-0 flex-1 truncate text-ink-muted">
        <span className="font-semibold text-ink">
          This writes with AI, but your profile doesn&apos;t say what you sell.{" "}
        </span>
        Drafts will stay general until you add your business details.
      </div>
      <Link
        href="/app/settings"
        className="flex-none rounded-control px-2 py-1 text-[12px] font-semibold text-brand hover:bg-brand-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
      >
        Add details
      </Link>
    </div>
  );
}
