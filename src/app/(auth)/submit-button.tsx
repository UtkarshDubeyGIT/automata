"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

/**
 * `useFormStatus` reads the *enclosing* form, so this has to be its own
 * component nested inside <form> — reading it in the component that renders
 * the form always reports `pending: false`.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "button button-primary auth-submit",
}: {
  children: ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : children}
    </button>
  );
}
