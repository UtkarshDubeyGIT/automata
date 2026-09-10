"use server";

import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { friendlyAuthError } from "@/lib/auth/errors";
import { safeNext } from "@/lib/auth/redirects";
import { publicOrigin } from "@/lib/request";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import type { AuthFormState } from "./form-state";

function value(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "").trim();
}

/** Passwords are never trimmed — leading/trailing spaces are part of the secret. */
function secret(formData: FormData, key: string): string {
  return String(formData.get(key) ?? "");
}

async function origin(): Promise<string> {
  // The configured public origin wins: behind the proxy it is the only thing
  // that names the host the browser can actually reach, and it keeps the link
  // we hand Supabase identical to the one /auth/callback redirects against.
  const configured = publicOrigin();
  if (configured) return configured;
  const requestHeaders = await headers();
  return requestHeaders.get("origin") ?? "http://localhost:3000";
}

async function callbackUrl(dest: string): Promise<string> {
  return `${await origin()}/auth/callback?next=${encodeURIComponent(dest)}`;
}

export async function signIn(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = value(formData, "email");
  const password = secret(formData, "password");
  // The hidden input is an attacker-controlled POST parameter; re-validate it
  // rather than trusting what the page rendered.
  const dest = safeNext(value(formData, "next"));

  // The page advertises a keyless preview. Honour it here, instead of letting
  // the client fall through to the localhost:54321 default in env.ts.
  if (!isSupabaseConfigured()) redirect(dest as Route);

  if (!email || !password) {
    return {
      status: "error",
      message: "Enter your email and password.",
      field: email ? "password" : "email",
      values: { email },
    };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const friendly = friendlyAuthError(error);
    return {
      status: "error",
      message: friendly.message,
      canResend: friendly.canResend,
      field: friendly.field,
      values: { email },
    };
  }

  // Last statement, outside any try/catch: redirect() throws NEXT_REDIRECT and
  // a catch block here would swallow the navigation.
  redirect(dest as Route);
}

export async function signUp(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const fullName = value(formData, "fullName");
  const email = value(formData, "email");
  const password = secret(formData, "password");
  const dest = safeNext(value(formData, "next"));

  if (!isSupabaseConfigured()) redirect(dest as Route);

  if (!fullName) {
    return { status: "error", message: "Tell us your name.", field: "fullName", values: { email } };
  }
  if (!email) {
    return { status: "error", message: "Enter your work email.", field: "email", values: { fullName } };
  }
  if (password.length < 8) {
    return {
      status: "error",
      message: "Use at least 8 characters for your password.",
      field: "password",
      values: { fullName, email },
    };
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName }, emailRedirectTo: await callbackUrl(dest) },
  });

  if (error) {
    const friendly = friendlyAuthError(error);
    return {
      status: "error",
      message: friendly.message,
      field: friendly.field,
      values: { fullName, email },
    };
  }

  // Confirmation is on, so there is no session yet. Stay put and say so inline —
  // the old `/login?message=...` hop lost the address a resend needs.
  if (!data.session) {
    return {
      status: "check_email",
      message: `Check ${email} for a confirmation link. It expires in an hour.`,
      canResend: true,
      values: { fullName, email },
    };
  }

  redirect(dest as Route);
}

/** Driven by its own sibling form inside the alert. */
export async function resendConfirmation(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = value(formData, "email");
  const dest = safeNext(value(formData, "next"));
  if (!email) return { status: "error", message: "Enter your email first." };
  if (!isSupabaseConfigured()) return { status: "sent", message: "Preview mode — no email sent." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: { emailRedirectTo: await callbackUrl(dest) },
  });

  if (error) {
    return { status: "error", message: friendlyAuthError(error).message, values: { email } };
  }
  return { status: "sent", message: "Sent. Check your inbox, and your spam folder.", values: { email } };
}

export async function requestPasswordReset(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = value(formData, "email");
  if (!email) return { status: "error", message: "Enter your email address.", field: "email" };
  if (!isSupabaseConfigured()) return { status: "sent", message: "Preview mode — no email sent." };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${await origin()}/auth/confirm?type=recovery&next=%2Freset-password`,
  });

  // Deliberately identical copy whether or not the address has an account —
  // otherwise this endpoint becomes a user-enumeration oracle.
  if (error) {
    const friendly = friendlyAuthError(error);
    if (friendly.code === "over_email_send_rate_limit" || friendly.code === "over_request_rate_limit") {
      return { status: "error", message: friendly.message, values: { email } };
    }
    console.error("[auth] password reset failed", { code: friendly.code });
  }
  return {
    status: "sent",
    message: `If an account exists for ${email}, a reset link is on its way.`,
    values: { email },
  };
}

export async function updatePassword(
  _prev: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = secret(formData, "password");
  const confirm = secret(formData, "confirmPassword");

  if (password.length < 8) {
    return { status: "error", message: "Use at least 8 characters.", field: "password" };
  }
  if (password !== confirm) {
    return { status: "error", message: "Those two passwords don't match.", field: "password" };
  }
  if (!isSupabaseConfigured()) redirect("/login" as Route);

  const supabase = await createServerSupabaseClient();
  // Requires the recovery session established by /auth/confirm.
  const { data: claims } = await supabase.auth.getClaims();
  if (!claims?.claims?.sub) {
    return {
      status: "error",
      message: "That reset link has expired. Request a new one.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password });
  if (error) {
    const friendly = friendlyAuthError(error);
    return { status: "error", message: friendly.message, field: friendly.field };
  }

  await supabase.auth.signOut();
  redirect("/login?notice=password_updated" as Route);
}

/**
 * Driven by its own small form, so it is a plain form action rather than a
 * `useActionState` reducer: there is nothing to type and nothing to echo back.
 */
export async function signInWithGoogle(formData: FormData): Promise<void> {
  const dest = safeNext(value(formData, "next"));

  if (!isSupabaseConfigured()) redirect(dest as Route);

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    // Google returns to Supabase, which returns here with `?code=`.
    options: { redirectTo: await callbackUrl(dest) },
  });

  // The provider being switched off in the Supabase dashboard shows up here,
  // not at the callback. Say so rather than bouncing to a blank consent page.
  if (error || !data.url) {
    console.error("[auth] google sign-in unavailable", { code: error?.code, status: error?.status });
    redirect("/login?notice=google_disabled" as Route);
  }

  // An absolute, off-origin URL — Google's consent screen.
  redirect(data.url as Route);
}

export async function signOut() {
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/");
}
