import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * Behind Caddy, Next reports `request.url` as the container's own address, so
 * `new URL("/app", request.url)` produced `https://localhost:3000/app` — which
 * is how a successful Google sign-in still ended on a dead host in the browser.
 * Redirects hang off the configured public origin instead.
 */

// A mutable stand-in: env.ts snapshots process.env at import, so setting the
// variable per case would need a fresh module graph each time.
const env = { appUrl: "" };
mock.module("@/lib/env", { namedExports: { env } });

const { publicUrl, publicOrigin } = await import("@/lib/request");

/** What Next hands the route handler inside the container. */
const CONTAINER = new Request("https://localhost:3000/auth/callback?code=abc");

test("a redirect ignores the origin the container sees", () => {
  env.appUrl = "https://automata.doubtbuddy.com";
  assert.equal(publicUrl("/app", CONTAINER).toString(), "https://automata.doubtbuddy.com/app");
});

test("a bare APP_HOST is treated as https", () => {
  env.appUrl = "automata.doubtbuddy.com";
  assert.equal(publicUrl("/app", CONTAINER).origin, "https://automata.doubtbuddy.com");
});

test("query and notice codes survive", () => {
  env.appUrl = "https://automata.doubtbuddy.com";
  assert.equal(
    publicUrl("/login?notice=verify_failed", CONTAINER).toString(),
    "https://automata.doubtbuddy.com/login?notice=verify_failed",
  );
});

test("localhost stays localhost in development", () => {
  env.appUrl = "http://localhost:3000";
  assert.equal(publicUrl("/app", CONTAINER).origin, "http://localhost:3000");
});

test("an unparseable value falls back to the request rather than throwing", () => {
  env.appUrl = "://nonsense";
  assert.equal(publicOrigin(CONTAINER), CONTAINER.url);
});
