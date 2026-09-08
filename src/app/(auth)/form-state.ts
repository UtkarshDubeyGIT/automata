/**
 * What a login/signup attempt hands back to the form.
 *
 * This is serialized to the client, so it carries nothing secret — notably
 * never the password. It lives outside `actions.ts` because a `"use server"`
 * module may only export async functions.
 */
export type AuthFormState = {
  status: "idle" | "error" | "check_email" | "sent";
  message?: string;
  /** `email_not_confirmed` — the form offers a resend button. */
  canResend?: boolean;
  /** Which control to mark invalid. */
  field?: "email" | "password" | "fullName";
  /** Echoed so the fields refill after React resets the form. */
  values?: { email?: string; fullName?: string };
};

export const IDLE: AuthFormState = { status: "idle" };
