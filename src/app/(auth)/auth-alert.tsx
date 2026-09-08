"use client";

import { useActionState } from "react";

import { resendConfirmation } from "./actions";
import { IDLE, type AuthFormState } from "./form-state";

export function AuthAlert({ state, next }: { state: AuthFormState; next: string }) {
  const [resend, resendAction, resending] = useActionState(resendConfirmation, IDLE);

  if (state.status === "idle" || !state.message) return null;

  return (
    <div className={state.status === "error" ? "auth-alert error" : "auth-alert"} role="alert" aria-live="polite">
      <p>{state.message}</p>
      {state.canResend && resend.status !== "sent" ? (
        // A sibling form, never nested: nested <form> is invalid HTML and React
        // will not hydrate it. The address comes from the action's echoed
        // values so the user does not have to retype it.
        <form action={resendAction} className="auth-alert__action">
          <input type="hidden" name="email" value={state.values?.email ?? ""} />
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="auth-alert__link" disabled={resending}>
            {resending ? "Sending…" : "Resend the confirmation email"}
          </button>
        </form>
      ) : null}
      {resend.message ? <p className="auth-alert__note">{resend.message}</p> : null}
    </div>
  );
}
