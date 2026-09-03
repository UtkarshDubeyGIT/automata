import * as React from "react";
import { cn } from "@/lib/utils";

type Tone =
  | "brand"
  | "neutral"
  | "success"
  | "warning"
  | "danger"
  | "info";

const TONE: Record<Tone, string> = {
  brand: "bg-brand-subtle text-brand border-brand-border",
  neutral: "bg-inset text-ink-muted border-transparent",
  success: "bg-success-surface text-success border-success-border",
  warning: "bg-warning-surface text-warning border-warning-border",
  danger: "bg-danger-surface text-danger border-danger-border",
  info: "bg-brand-subtle text-brand border-brand-border",
};

export function Badge({
  children,
  tone = "neutral",
  dot,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-medium",
        TONE[tone],
        className,
      )}
    >
      {dot && (
        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
      )}
      {children}
    </span>
  );
}

/** Small pill tag (filters, keywords). */
export function Tag({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-[12px] font-medium",
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
