"use client";

import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/**
 * The numbered progress rail.
 *
 * Steps already visited stay clickable so the back button is not the only way
 * to correct an answer; steps ahead are inert, because jumping forward past a
 * question is what the Skip link is for.
 */
export function StepChips({
  labels,
  current,
  furthest,
  onJump,
}: {
  labels: readonly string[];
  /** Zero-based. */
  current: number;
  /** Highest step reached, so a resumed run keeps its earlier steps reachable. */
  furthest: number;
  onJump: (index: number) => void;
}) {
  return (
    <ol className="flex flex-wrap items-start justify-center gap-x-1 gap-y-3">
      {labels.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const reachable = i <= furthest;
        return (
          <li key={label} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => reachable && onJump(i)}
              disabled={!reachable}
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex w-[74px] flex-col items-center gap-1.5 rounded-control px-1 py-1 transition-opacity",
                reachable ? "cursor-pointer hover:opacity-80" : "cursor-default",
                "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
              )}
            >
              <span
                className={cn(
                  "flex h-7 w-7 flex-none items-center justify-center rounded-full border text-[12px] font-semibold tabular-nums transition-colors",
                  active
                    ? "border-brand bg-brand text-on-brand"
                    : done
                      ? "border-brand bg-brand-subtle text-brand"
                      : "border-line bg-card text-ink-disabled",
                )}
              >
                {done ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <span
                className={cn(
                  "text-center text-[11px] leading-tight",
                  active ? "font-medium text-ink" : done ? "text-ink-subtle" : "text-ink-disabled",
                )}
              >
                {label}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
