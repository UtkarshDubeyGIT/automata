"use client";

import { signInWithGoogle } from "./actions";
import { SubmitButton } from "./submit-button";

/** Google's brand mark, inlined — its four colours are fixed by their guidelines. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8a10 10 0 0 1-4.4 6.6v5.5h7.1c4.2-3.8 6.6-9.5 6.6-16.3z" />
      <path fill="#34A853" d="M24 46c6 0 11-2 14.5-5.2l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.4v5.7A22 22 0 0 0 24 46z" />
      <path fill="#FBBC05" d="M11.7 28.3a13.2 13.2 0 0 1 0-8.6v-5.7H4.4a22 22 0 0 0 0 20l7.3-5.7z" />
      <path fill="#EA4335" d="M24 9.5c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 2.9 30 1 24 1A22 22 0 0 0 4.4 14l7.3 5.7c1.7-5.2 6.6-9.2 12.3-9.2z" />
    </svg>
  );
}

/**
 * A sibling form, never nested inside the email form — nested <form> is
 * invalid HTML and React will not hydrate it.
 */
export function GoogleButton({ next, label = "Continue with Google" }: { next: string; label?: string }) {
  return (
    <>
      <form action={signInWithGoogle} className="auth-oauth">
        {/* Re-validated server-side through safeNext — this is user input. */}
        <input type="hidden" name="next" value={next} />
        <SubmitButton className="button auth-oauth__button" pendingLabel="Taking you to Google…">
          <GoogleMark />
          {label}
        </SubmitButton>
      </form>
      <div className="auth-divider" role="separator">
        <span>or</span>
      </div>
    </>
  );
}
