"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

const CONTROL =
  "w-full rounded-control border border-line bg-card px-3.5 text-[14px] text-ink placeholder:text-ink-disabled " +
  "transition-[border-color,box-shadow] duration-150 " +
  "focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[color:rgba(74,69,209,0.32)] " +
  "disabled:cursor-not-allowed disabled:opacity-60";

export function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-ink">
          {label}
        </label>
      )}
      {children}
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : (
        hint && <span className="text-[12px] text-ink-subtle">{hint}</span>
      )}
    </div>
  );
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { leftIcon?: string }
>(({ className, leftIcon, ...props }, ref) => {
  if (leftIcon) {
    return (
      <div className="relative">
        <Icon
          name={leftIcon}
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle"
        />
        <input
          ref={ref}
          className={cn(CONTROL, "h-10 pl-9", className)}
          {...props}
        />
      </div>
    );
  }
  return (
    <input ref={ref} className={cn(CONTROL, "h-10", className)} {...props} />
  );
});
Input.displayName = "Input";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea
    ref={ref}
    className={cn(CONTROL, "min-h-24 resize-y py-2.5 leading-relaxed", className)}
    {...props}
  />
));
Textarea.displayName = "Textarea";

export const Select = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...props }, ref) => (
  <div className="relative">
    <select
      ref={ref}
      className={cn(
        CONTROL,
        "h-10 cursor-pointer appearance-none pr-9",
        className,
      )}
      {...props}
    >
      {children}
    </select>
    <Icon
      name="chevron-down"
      size={16}
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-subtle"
    />
  </div>
));
Select.displayName = "Select";

export function Checkbox({
  checked,
  onChange,
  label,
  className,
}: {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "inline-flex cursor-pointer items-center gap-2.5 text-[14px] text-ink",
        className,
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={!!checked}
        onClick={() => onChange?.(!checked)}
        className={cn(
          "flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border transition-colors duration-150",
          checked
            ? "border-brand bg-brand text-white"
            : "border-line-strong bg-card hover:border-brand",
        )}
      >
        {checked && <Icon name="check" size={13} strokeWidth={3} />}
      </button>
      {label}
    </label>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  className,
  disabled,
}: {
  checked?: boolean;
  onChange?: (v: boolean) => void;
  label?: React.ReactNode;
  className?: string;
  /** In flight. Without this a double-click sends two conflicting writes. */
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "inline-flex items-center gap-2.5 text-[14px] text-ink",
        disabled ? "cursor-progress opacity-60" : "cursor-pointer",
        className,
      )}
    >
      <button
        type="button"
        role="switch"
        aria-checked={!!checked}
        disabled={disabled}
        onClick={() => onChange?.(!checked)}
        className={cn(
          "relative h-[22px] w-[38px] rounded-full transition-colors duration-200",
          checked ? "bg-brand" : "bg-gray-300",
          disabled && "cursor-progress",
        )}
      >
        <span
          className={cn(
            "absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] duration-200",
            checked ? "left-[19px]" : "left-[3px]",
          )}
        />
      </button>
      {label}
    </label>
  );
}
