"use client";

import { useActionState } from "react";

import { PasswordInput } from "@/components/ui";
import { updatePassword } from "../actions";
import { AuthAlert } from "../auth-alert";
import { IDLE } from "../form-state";
import { SubmitButton } from "../submit-button";

export function ResetPasswordForm() {
  const [state, formAction] = useActionState(updatePassword, IDLE);
  const invalid = state.status === "error" && state.field === "password" ? true : undefined;

  return (
    <>
      <AuthAlert state={state} next="/app" />
      <form action={formAction} className="auth-form">
        <label htmlFor="password">
          New password
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            minLength={8}
            placeholder="At least 8 characters"
            aria-invalid={invalid}
            required
          />
        </label>
        <label htmlFor="confirmPassword">
          Confirm new password
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            autoComplete="new-password"
            minLength={8}
            placeholder="Type it again"
            aria-invalid={invalid}
            required
          />
        </label>
        <SubmitButton pendingLabel="Saving…">Set new password</SubmitButton>
      </form>
    </>
  );
}
