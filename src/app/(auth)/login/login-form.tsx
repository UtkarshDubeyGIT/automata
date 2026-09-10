"use client";

import Link from "next/link";
import { useActionState } from "react";

import { PasswordInput } from "@/components/ui";
import { signIn } from "../actions";
import { AuthAlert } from "../auth-alert";
import { GoogleButton } from "../google-button";
import { IDLE } from "../form-state";
import { SubmitButton } from "../submit-button";

export function LoginForm({ next }: { next: string }) {
  const [state, formAction] = useActionState(signIn, IDLE);
  const invalid = (field: string) =>
    state.status === "error" && state.field === field ? true : undefined;

  const signupHref = next === "/app" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`;

  return (
    <>
      <AuthAlert state={state} next={next} />
      <GoogleButton next={next} />
      <form action={formAction} className="auth-form">
        {/* Re-validated server-side through safeNext — this is user input. */}
        <input type="hidden" name="next" value={next} />
        <label htmlFor="email">
          Email address
          <input
            id="email"
            type="email"
            name="email"
            autoComplete="email"
            placeholder="you@company.com"
            // React resets an uncontrolled form once the action settles;
            // re-seeding defaultValue is what makes the typed value survive.
            defaultValue={state.values?.email ?? ""}
            aria-invalid={invalid("email")}
            required
          />
        </label>
        <label htmlFor="password">
          <span className="auth-label-row">
            Password
            <Link href="/forgot-password">Forgot password?</Link>
          </span>
          {/* Deliberately not refilled: the password never rides in action state. */}
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            placeholder="Your password"
            aria-invalid={invalid("password")}
            required
          />
        </label>
        <SubmitButton pendingLabel="Signing in…">Sign in</SubmitButton>
      </form>
      <p className="auth-switch">
        New to Automata? <Link href={signupHref}>Create an account</Link>
      </p>
    </>
  );
}
