import { strict as assert } from "node:assert";
import { test } from "node:test";
import { friendlyAuthError, NOTICE_COPY } from "@/lib/auth/errors";
import type { AuthError } from "@supabase/supabase-js";

/**
 * Sign-in errors used to be echoed straight through the URL
 * (`/login?error=<raw supabase message>`) and rendered verbatim. That leaked
 * internals, read like a stack trace, and let anyone craft a login URL that
 * displayed arbitrary prose to the person opening it.
 */

function err(partial: Partial<AuthError>): AuthError {
  return { name: "AuthApiError", message: "", ...partial } as AuthError;
}

test("maps a known code to human copy", () => {
  const out = friendlyAuthError(err({ code: "invalid_credentials", message: "Invalid login credentials" }));
  assert.equal(out.code, "invalid_credentials");
  assert.match(out.message, /don't match/);
});

test("wrong password and unknown account are indistinguishable", () => {
  // Supabase collapses both into invalid_credentials on purpose, so the
  // endpoint cannot be used to enumerate who has an account. Our copy must
  // not undo that by hinting which one it was.
  const out = friendlyAuthError(err({ code: "invalid_credentials" }));
  assert.doesNotMatch(out.message, /no account|not found|doesn't exist|unregistered/i);
});

test("email_not_confirmed offers a resend", () => {
  const out = friendlyAuthError(err({ code: "email_not_confirmed" }));
  assert.equal(out.canResend, true);
  assert.equal(out.field, "email");
});

test("falls back to the message when the error carries no code", () => {
  const out = friendlyAuthError(err({ message: "Invalid login credentials" }));
  assert.equal(out.code, "invalid_credentials");
});

test("treats a bare 429 as a rate limit", () => {
  const out = friendlyAuthError(err({ status: 429, message: "nope" }));
  assert.equal(out.code, "over_request_rate_limit");
});

test("never returns an unmapped supabase message verbatim", () => {
  const raw = "pq: duplicate key value violates unique constraint \"users_pkey\"";
  const out = friendlyAuthError(err({ code: "internal_error", message: raw }));
  assert.notEqual(out.message, raw);
  assert.doesNotMatch(out.message, /constraint|pq:/);
});

test("a null error is not an error", () => {
  assert.equal(friendlyAuthError(null).message, "");
});

test("notice codes all resolve to copy", () => {
  for (const [code, copy] of Object.entries(NOTICE_COPY)) {
    assert.ok(copy.length > 0, `${code} has no copy`);
  }
});
