/**
 * Keeps operator setup hints out of the deployed app.
 *
 * When a provider key is missing, a feature degrades to a stub (see the
 * `*Configured` booleans in `@/lib/env`) and tells somebody why. "Add a Twilio
 * Verify Service SID" is the right thing to tell whoever runs the app on their
 * laptop and meaningless — alarming, even — to a customer on the live site, who
 * cannot act on it and did not ask to read our environment variable names.
 *
 * So every one of those messages has two forms: what a customer should read,
 * and the hint that names the variable. `setupNotice()` picks between them.
 *
 * Two deliberate choices:
 *
 * - This module imports NOTHING. `"use client"` components are barred from
 *   reaching `@/lib/env` (tests/pure-modules.test.ts), and they need this too.
 * - The check is `NODE_ENV === "development"`, read at call time. `next dev`
 *   sets exactly that value and `next build` sets `production`, so the hint
 *   appears while developing locally and nowhere else. Testing for
 *   `development` rather than "not production" makes it fail closed: an unset
 *   or unexpected value hides the hint instead of showing it. Written as a
 *   static property expression, the only form Next.js inlines into a client
 *   bundle — so the branch is compiled away for the browser.
 */

/** True only while running locally under `next dev`. */
export function showSetupHints(): boolean {
  return process.env.NODE_ENV === "development";
}

/**
 * `devHint` locally, `userText` on the live site.
 *
 * Put the environment variable name in `devHint` — never in `userText`, which
 * is the half real users read.
 */
export function setupNotice(userText: string, devHint: string): string {
  return showSetupHints() ? devHint : userText;
}
