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
        "flex items-start gap-2 rounded-card border border-warning-border bg-warning-surface px-3.5 py-3"
      }
    >
      <Icon name="sparkles" size={14} className="mt-0.5 flex-none text-warning" />
      <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink-muted">
        <span className="font-semibold text-ink">
          This writes with AI, but your profile doesn&apos;t say what you sell.{" "}
        </span>
        It will still run — the drafts just have to stay general, because the
        model is told not to invent specifics about you. Filling this in is the
        single biggest difference between a generic post and one that sounds
        like your business.
      </div>
      <Link
        href="/app/settings"
        className="flex-none text-[12px] font-semibold text-brand hover:underline"
      >
        Add details
      </Link>
    </div>
  );
}
