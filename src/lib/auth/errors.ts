import type { AuthError } from "@supabase/supabase-js";

export type FriendlyAuthError = {
  /** The upstream code, kept for logs. Never rendered raw. */
  code: string;
  message: string;
  field?: "email" | "password" | "fullName";
  /** Drives the "resend confirmation" affordance. */
  canResend?: boolean;
};

/**
 * Supabase returns `invalid_credentials` for both a wrong password and an
 * address with no account — deliberately, so the endpoint cannot be used to
 * enumerate users. The copy must not tell them apart.
 */
const COPY: Record<string, Omit<FriendlyAuthError, "code">> = {
  invalid_credentials: {
    message: "That email and password don't match. Check for typos, or reset your password.",
    field: "password",
  },
  email_not_confirmed: {
    message: "Confirm your email before signing in — we sent a link when you signed up.",
    canResend: true,
    field: "email",
  },
  over_email_send_rate_limit: {
    message: "We've already sent a few emails to this address. Wait a minute, then try again.",
  },
  over_request_rate_limit: { message: "Too many attempts. Wait a minute and try again." },
  user_already_exists: {
    message: "An account already exists for this email. Sign in instead.",
    field: "email",
  },
  email_exists: {
    message: "An account already exists for this email. Sign in instead.",
    field: "email",
  },
  weak_password: {
    message: "Pick a stronger password — at least 8 characters, and not one you use elsewhere.",
    field: "password",
  },
  email_address_invalid: {
    message: "That doesn't look like a valid email address.",
    field: "email",
  },
  email_address_not_authorized: { message: "This address isn't allowed to sign up yet." },
  signup_disabled: { message: "New signups are paused right now. Check back shortly." },
  validation_failed: { message: "Check the details above and try again." },
  user_banned: { message: "This account is suspended. Contact support." },
  otp_expired: { message: "That link expired. Request a fresh one." },
  same_password: {
    message: "That's already your current password. Pick a different one.",
    field: "password",
  },
};

/**
 * Older gotrue builds — and any error raised before a response arrives — carry
 * no `code`, only a message. Sniff those.
 */
const BY_MESSAGE: [RegExp, string][] = [
  [/invalid login credentials/i, "invalid_credentials"],
  [/email not confirmed/i, "email_not_confirmed"],
  [/already registered|already exists/i, "user_already_exists"],
  [/password should be at least|weak password/i, "weak_password"],
  [/rate limit|too many requests/i, "over_request_rate_limit"],
];

export function friendlyAuthError(error: AuthError | null | undefined): FriendlyAuthError {
  if (!error) return { code: "none", message: "" };

  const code =
    (error.code as string | undefined) ??
    BY_MESSAGE.find(([re]) => re.test(error.message ?? ""))?.[1] ??
    (error.status === 429 ? "over_request_rate_limit" : "unknown");

  const known = COPY[code];
  if (known) return { code, ...known };

  // Raw Supabase strings leak internals and read like a stack trace to a user.
  // Log the original, show a sentence.
  console.error("[auth] unmapped error", { code, status: error.status, message: error.message });
  return { code, message: "We couldn't complete that. Try again in a moment." };
}

/** Codes carried in `?notice=` by real HTTP redirects (the auth callback). */
export const NOTICE_COPY: Record<string, string> = {
  verify_failed: "That sign-in link couldn't be verified. It may have expired — request a new one.",
  link_expired: "That link has expired. Request a new one below.",
  google_disabled: "Google sign-in isn't available right now. Use your email and password.",
  confirmed: "Email confirmed. Sign in to continue.",
  password_updated: "Password updated. Sign in with your new password.",
  signed_out: "You've been signed out.",
};
