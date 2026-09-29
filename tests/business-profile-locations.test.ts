import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("@/lib/env", { namedExports: {
  googleBusinessConfigured: true,
  env: { googleClientId: "client", googleClientSecret: "secret", appUrl: "http://localhost" },
} });
mock.module("@/lib/credentials", { namedExports: {
  readCredential: async () => ({
    refreshToken: "refresh", accessToken: "access", expiresAt: Date.now() + 600_000,
    accountName: "accounts/1", locationName: "locations/1",
  }),
  saveCredential: async () => {},
  deleteCredential: async () => {},
} });

const { businessLocations, listReviews } = await import("@/lib/google/business-profile");

test("business choices include locations under every accessible account", async () => {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/accounts")) return Response.json({ accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] });
    if (url.includes("accounts/1/locations")) return Response.json({ locations: [{ name: "locations/1", title: "Cafe" }] });
    if (url.includes("accounts/2/locations")) return Response.json({ locations: [{ name: "locations/2", title: "Studio" }] });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  assert.deepEqual(await businessLocations("workspace-1"), [
    { name: "locations/1", title: "Cafe", account: "accounts/1" },
    { name: "locations/2", title: "Studio", account: "accounts/2" },
  ]);
});

test("review reads use only a location accessible to this workspace", async () => {
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/accounts")) return Response.json({ accounts: [{ name: "accounts/1" }, { name: "accounts/2" }] });
    if (url.includes("accounts/1/locations")) return Response.json({ locations: [{ name: "locations/1", title: "Cafe" }] });
    if (url.includes("accounts/2/locations")) return Response.json({ locations: [{ name: "locations/2", title: "Studio" }] });
    if (url.includes("accounts/2/locations/2/reviews")) return Response.json({ reviews: [] });
    throw new Error(`Unexpected URL: ${url}`);
  }) as typeof fetch;
  assert.deepEqual(await listReviews("workspace-1", 20, "locations/2"), { reviews: [] });
  assert.ok(calls.some((url) => url.includes("accounts/2/locations/2/reviews")));
  await assert.rejects(() => listReviews("workspace-1", 20, "locations/999"), /not accessible/i);
});
