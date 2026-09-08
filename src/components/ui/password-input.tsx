"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";

/**
 * A password field that can be unmasked.
 *
 * The toggle sits inside the control, so the input reserves room on the right
 * (see `.password-field` in marketing.css) — without it a long password runs
 * underneath the button.
 *
 * The `type` swap happens on the same DOM node, so React does not remount it
 * and the value and caret position survive the toggle. Appearance comes from
 * the caller: the auth pages inherit `.auth-form input`, product forms can pass
 * the Tailwind CONTROL classes.
 */
export const PasswordInput = React.forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> & { wrapperClassName?: string }
>(({ className, wrapperClassName, id, ...props }, ref) => {
  const [visible, setVisible] = React.useState(false);
  const generatedId = React.useId();
  const inputId = id ?? generatedId;

  return (
    <span className={cn("password-field", wrapperClassName)}>
      <input ref={ref} id={inputId} type={visible ? "text" : "password"} className={className} {...props} />
      <button
        // Never `submit`: inside <form action={...}> a bare <button> would fire
        // the server action every time someone peeked at their password.
        type="button"
        className="password-toggle"
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
        aria-controls={inputId}
        // Otherwise password managers overlay their own glyph on the toggle.
        data-1p-ignore
        onClick={() => setVisible((v) => !v)}
      >
        <Icon name={visible ? "eye-off" : "eye"} size={17} />
      </button>
    </span>
  );
});
PasswordInput.displayName = "PasswordInput";
