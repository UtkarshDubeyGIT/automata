import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

export function Stat({
  label,
  value,
  delta,
  caption,
  icon,
  trend = "up",
  className,
}: {
  label: string;
  value: React.ReactNode;
  delta?: string;
  caption?: string;
  icon?: IconName;
  trend?: "up" | "down" | "flat";
  className?: string;
}) {
  const deltaColor =
    trend === "down"
      ? "text-danger"
      : trend === "flat"
        ? "text-ink-subtle"
        : "text-success";
  return (
    <div
      className={cn(
        "rounded-card border border-line bg-card p-5 shadow-sm",
        className,
      )}
    >
      <div className="flex items-center justify-between">
        {icon && (
          <span className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-brand-subtle text-brand">
            <Icon name={icon} size={17} />
          </span>
        )}
        <Icon
          name="arrow-up-right"
          size={16}
          className="text-ink-disabled"
        />
      </div>
      <div className="mt-4 font-display text-[30px] font-semibold leading-none tracking-[-0.02em] text-ink tabular-nums">
        {value}
      </div>
      <div className="mt-1.5 text-[13px] text-ink-subtle">{label}</div>
      {delta && (
        <div className={cn("mt-3 text-[13px] font-medium", deltaColor)}>
          {delta}
          {caption && (
            <span className="ml-1 font-normal text-ink-subtle">{caption}</span>
          )}
        </div>
      )}
    </div>
  );
}
