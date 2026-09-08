"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { IconButton } from "./button";

export function ProgressBar({
  value,
  className,
  tone = "brand",
}: {
  value: number;
  className?: string;
  tone?: "brand" | "success" | "gradient";
}) {
  const fill =
    tone === "success"
      ? "bg-success"
      : tone === "gradient"
        ? "bg-gradient-to-r from-indigo-500 to-indigo-700"
        : "bg-brand";
  return (
    <div
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-inset", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width] duration-300 ease-out", fill)}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

/**
 * A hint attached to the control it describes.
 *
 * Opens on keyboard focus as well as hover — a tooltip that only answers a
 * mouse is a tooltip half the people who need it cannot read. `wide` is for
 * a sentence rather than a label: the default stays on one line, which is
 * right for "Pause" and wrong for "Zidane runs none of its remaining actions
 * until you resume it."
 */
export function Tooltip({
  content,
  children,
  side = "top",
  wide = false,
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "bottom";
  wide?: boolean;
}) {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 rounded-md bg-inverse px-2.5 py-1.5",
          "text-[12px] font-medium leading-snug text-page opacity-0 shadow-lg",
          "transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100",
          side === "bottom" ? "top-full mt-2" : "bottom-full mb-2",
          wide ? "w-[240px] whitespace-normal text-center" : "whitespace-nowrap",
        )}
      >
        {content}
      </span>
    </span>
  );
}

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 520,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      style={{ background: "var(--overlay-scrim)", backdropFilter: "blur(2px)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="w-full overflow-hidden rounded-modal border border-line bg-card shadow-xl"
        style={{
          maxWidth: width,
          animation: "dc-rise 0.2s var(--ease-out)",
        }}
      >
        {(title || subtitle) && (
          <div className="flex items-start justify-between gap-4 border-b border-line px-6 py-5">
            <div>
              {title && (
                <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-ink">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-1 text-[14px] text-ink-subtle">{subtitle}</p>
              )}
            </div>
            <IconButton icon="x" size="sm" label="Close" onClick={onClose} />
          </div>
        )}
        {children && <div className="px-6 py-5">{children}</div>}
        {footer && (
          <div className="flex justify-end gap-2 border-t border-line bg-sunken px-6 py-4">
            {footer}
          </div>
        )}
      </div>
      <style>{`@keyframes dc-rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}`}</style>
    </div>
  );
}
