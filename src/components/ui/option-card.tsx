"use client";

import { IconTile, type IconName } from "./icon";
import { cn } from "@/lib/utils";

/**
 * A pick-one card: tinted icon tile, label, one line of description.
 *
 * Built on a visually hidden native radio rather than the hand-rolled
 * `role="radio"` button used elsewhere in the kit. A radio *group* needs arrow
 * key navigation and roving focus to be usable, and the browser gives both away
 * for free with real inputs — reimplementing them by hand is where that pattern
 * usually goes wrong.
 *
 * Every state branch is written out in full rather than layered. `cn()` here is
 * clsx with no tailwind-merge (src/lib/utils.ts), so a later conflicting class
 * does not win — it just emits both and lets the cascade decide.
 */
export function OptionCard({
  name,
  selected,
  onSelect,
  icon,
  label,
  description,
  tint,
  disabled,
}: {
  /** Shared across the group; this is what makes the arrow keys work. */
  name: string;
  selected: boolean;
  onSelect: () => void;
  icon: IconName;
  label: string;
  description?: string;
  tint: { bg: string; fg: string };
  disabled?: boolean;
}) {
  return (
    <label className={cn("relative block", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input
        type="radio"
        name={name}
        checked={selected}
        onChange={onSelect}
        disabled={disabled}
        className="peer sr-only"
      />
      <span
        className={cn(
          "flex h-full items-start gap-3 rounded-card border p-3 text-left transition-[background-color,border-color,box-shadow] duration-150",
          "peer-focus-visible:border-focus peer-focus-visible:ring-[3px] peer-focus-visible:ring-ring",
          selected ? "border-brand bg-brand-subtle" : "border-line bg-card hover:border-line-strong hover:bg-inset",
        )}
      >
        <IconTile name={icon} bg={tint.bg} fg={tint.fg} size={32} iconSize={16} />
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-semibold leading-tight text-ink">{label}</span>
          {description ? (
            <span className="mt-0.5 block text-[12px] leading-snug text-ink-subtle">{description}</span>
          ) : null}
        </span>
      </span>
    </label>
  );
}
