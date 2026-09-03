import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({
  className,
  children,
  hover,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { hover?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-card border border-line bg-card shadow-sm",
        hover &&
          "transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  subtitle,
  icon,
  action,
  className,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", className)}>
      <div className="flex items-center gap-3">
        {icon && (
          <span className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-brand-subtle text-brand">
            {icon}
          </span>
        )}
        <div>
          {title && (
            <h3 className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-ink">
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="mt-0.5 text-[13px] text-ink-subtle">{subtitle}</p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

export function CardBody({
  className,
  children,
}: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("", className)}>{children}</div>;
}
