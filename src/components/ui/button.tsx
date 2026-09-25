"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "./icon";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "lg";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-brand text-on-brand shadow-[var(--shadow-brand)] hover:bg-brand-hover active:bg-brand-active",
  secondary:
    "bg-card text-ink border border-line hover:bg-inset hover:border-line-strong",
  ghost: "bg-transparent text-ink-muted hover:bg-inset hover:text-ink",
  subtle:
    "bg-brand-subtle text-brand border border-brand-border hover:bg-brand-subtle-hover",
  danger: "bg-transparent text-danger hover:bg-transparent hover:text-danger",
};

const SIZE: Record<Size, string> = {
  sm: "h-8 px-3 text-[13px] gap-1.5 rounded-[8px]",
  md: "h-10 px-4 text-[14px] gap-2 rounded-control",
  lg: "h-12 px-5 text-[15px] gap-2 rounded-control",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      icon,
      iconRight,
      loading,
      className,
      children,
      disabled,
      ...props
    },
    ref,
  ) => {
    const iconSize = size === "sm" ? 15 : 17;
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex select-none items-center justify-center font-medium",
          "transition-[background-color,border-color,color,box-shadow,transform] duration-150",
          "active:translate-y-[0.5px] active:scale-[0.992]",
          "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
          "disabled:pointer-events-none disabled:opacity-50",
          VARIANT[variant],
          SIZE[size],
          className,
        )}
        {...props}
      >
        {loading ? (
          <Icon name="refresh" size={iconSize} className="animate-spin" />
        ) : (
          icon && <Icon name={icon} size={iconSize} />
        )}
        {children}
        {iconRight && <Icon name={iconRight} size={iconSize} />}
      </button>
    );
  },
);
Button.displayName = "Button";

export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  className,
  label,
  ...props
}: {
  icon: IconName;
  size?: Size;
  variant?: Variant;
  label?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const box = size === "sm" ? "h-8 w-8" : size === "lg" ? "h-12 w-12" : "h-10 w-10";
  const iconSize = size === "sm" ? 16 : 18;
  return (
    <button
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center rounded-control",
        "transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.94]",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANT[variant],
        box,
        className,
      )}
      {...props}
    >
      <Icon name={icon} size={iconSize} />
    </button>
  );
}
