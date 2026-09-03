import * as React from "react";
import { cn } from "@/lib/utils";

export function PageHeader({
  title,
  subtitle,
  action,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-6", className)}>
      <div>
        <h1 className="font-display text-[34px] font-semibold leading-tight tracking-[-0.025em] text-ink">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-2 max-w-2xl text-[16px] leading-relaxed text-ink-subtle">
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="flex-none">{action}</div>}
    </div>
  );
}
