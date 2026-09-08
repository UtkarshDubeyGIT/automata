import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.NEXT_PUBLIC_APP_URL ||= "https://zidaneai.com";

const { completeOAuthReturn } = await import("@/lib/social/oauth-return");
const { stateMessage } = await import("@/lib/google/business-profile");

/**
 * "Connected" and "usable" are two facts, and the return leg has to carry both.
 *
 * Signing into Google Business Profile with a personal Google account produces
 * a perfectly real grant attached to an account that manages no business on
 * Maps. Every step will fail, and nothing said so: the row went green and the
 * first symptom was a failed run — after a human had approved the reply the AI
 * drafted. Reporting it as a FAILURE instead would be its own trap, sending
 * the user to reconnect the same account forever, so it travels beside
 * `connected: true` rather than replacing it.
 */

const NO_LISTING = stateMessage("no_location");

test("the message names the fix, not just the fault", () => {
  assert.match(NO_LISTING, /manages no business listings/);
  assert.match(NO_LISTING, /connect the account that owns the listing/);
});

test("the popup leg hands the warning to the tab that started the flow", async () => {
  const res = completeOAuthReturn(
    new URL("https://automata.example/app/workflows/wf-1"),
    "googlebusinessprofile",
    true,
    true,
    NO_LISTING,
  );
  const html = await res.text();

  // Still a success — the grant is real and the row should go green.
  assert.match(html, /"connected":true/);
  assert.ok(html.includes(JSON.stringify(NO_LISTING).slice(1, -1)), "warning must ride along");
});

test("a clean connection carries no warning at all", async () => {
  const res = completeOAuthReturn(
    new URL("https://automata.example/app/workflows/wf-1"),
    "googlebusinessprofile",
    true,
    true,
  );
  const html = await res.text();
  assert.match(html, /"connected":true/);
  assert.ok(!html.includes("warning"), "nothing to say means saying nothing");
});

test("the full-page leg carries it as a query parameter", () => {
  const res = completeOAuthReturn(
    new URL("https://automata.example/app/integrations"),
    "googlebusinessprofile",
    true,
    false,
    NO_LISTING,
  );
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.searchParams.get("connected"), "googlebusinessprofile");
  assert.equal(location.searchParams.get("warning"), NO_LISTING);
});

test("a failed connection is never dressed up as a warning", () => {
  // `error` and `warning` are different outcomes and must not blur: one means
  // try again, the other means try a different Google account.
  const res = completeOAuthReturn(
    new URL("https://automata.example/app/integrations"),
    "googlebusinessprofile",
    false,
    false,
    NO_LISTING,
  );
  const location = new URL(res.headers.get("location")!);
  assert.equal(location.searchParams.get("error"), "googlebusinessprofile");
  assert.equal(location.searchParams.get("warning"), null);
  assert.equal(location.searchParams.get("connected"), null);
});
