"use client";

import Link from "next/link";
import { useActionState } from "react";

import { requestPasswordReset } from "../actions";
import { AuthAlert } from "../auth-alert";
import { IDLE } from "../form-state";
import { SubmitButton } from "../submit-button";

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState(requestPasswordReset, IDLE);

  return (
    <>
      <AuthAlert state={state} next="/app" />
      {state.status === "sent" ? null : (
        <form action={formAction} className="auth-form">
          <label htmlFor="email">
            Email address
            <input
              id="email"
              type="email"
              name="email"
              autoComplete="email"
              placeholder="you@company.com"
              defaultValue={state.values?.email ?? ""}
              aria-invalid={state.status === "error" && state.field === "email" ? true : undefined}
              required
            />
          </label>
          <SubmitButton pendingLabel="Sending…">Email me a reset link</SubmitButton>
        </form>
      )}
      <p className="auth-switch">
        Remembered it? <Link href="/login">Back to sign in</Link>
      </p>
    </>
  );
}
