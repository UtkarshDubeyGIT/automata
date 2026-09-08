"use client";

import Link from "next/link";
import { useActionState } from "react";

import { PasswordInput } from "@/components/ui";
import { signUp } from "../actions";
import { AuthAlert } from "../auth-alert";
import { IDLE } from "../form-state";
import { SubmitButton } from "../submit-button";

export function SignupForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(signUp, IDLE);
  const invalid = (field: string) =>
    state.status === "error" && state.field === field ? true : undefined;

  const loginHref = next === "/app" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  // Once the confirmation email is out there is nothing left to type, so the
  // alert (and its resend button) replaces the form entirely.
  if (state.status === "check_email") {
    return (
      <>
        <AuthAlert state={state} next={next} />
        <p className="auth-switch">
          Already confirmed? <Link href={loginHref}>Sign in</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <AuthAlert state={state} next={next} />
      <form action={formAction} className="auth-form">
        <input type="hidden" name="next" value={next} />
        <label htmlFor="fullName">
          Full name
          <input
            id="fullName"
            name="fullName"
            autoComplete="name"
            placeholder="Alex Morgan"
            defaultValue={state.values?.fullName ?? ""}
            aria-invalid={invalid("fullName")}
            required
          />
        </label>
        <label htmlFor="email">
          Work email
          <input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@company.com"
            defaultValue={state.values?.email ?? ""}
            aria-invalid={invalid("email")}
            required
          />
        </label>
        <label htmlFor="password">
          Password
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            minLength={8}
            placeholder="At least 8 characters"
            aria-invalid={invalid("password")}
            required
          />
        </label>
        <SubmitButton pendingLabel="Creating your workspace…">Create free workspace</SubmitButton>
      </form>
      <p className="auth-switch">
        Already have an account? <Link href={loginHref}>Sign in</Link>
      </p>
    </>
  );
}
