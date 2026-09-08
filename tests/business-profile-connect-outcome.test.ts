import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

const saved: unknown[] = [];
mock.module("@/lib/credentials", {
  namedExports: {
    readCredential: async () => null,
    saveCredential: async (...args: unknown[]) => { saved.push(args); },
    deleteCredential: async () => {},
  },
});

const { completeConnect } = await import("@/lib/google/business-profile");

function googleResponses(accounts: unknown, locations?: unknown) {
  saved.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    assert.equal(saved.length, 1, "persist the OAuth grant before discovering the listing");
    return Response.json(String(input).includes("/locations?") ? locations : accounts);
  }) as typeof fetch;
}

test("a Google account without a business remains connected and reports the missing listing", async () => {
  googleResponses({ accounts: [] });
  assert.deepEqual(await completeConnect("workspace-1", "code"), { checked: true, listing: false });
  assert.equal(saved.length, 1);
});

test("a usable business listing is saved and reported to the OAuth callback", async () => {
  googleResponses({ accounts: [{ name: "accounts/1" }] }, { locations: [{ name: "locations/1" }] });
  assert.deepEqual(await completeConnect("workspace-1", "code"), { checked: true, listing: true });
  assert.equal(saved.length, 2);
  assert.deepEqual((saved[1] as unknown[])[2], {
    ...(saved[0] as unknown[])[2] as object,
    accountName: "accounts/1",
    locationName: "locations/1",
  });
});

test("a lookup outage keeps the grant without claiming the account has no listing", async () => {
  saved.length = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes("oauth2.googleapis.com/token")) {
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
    }
    return Response.json({ error: { message: "Temporarily unavailable" } }, { status: 503 });
  }) as typeof fetch;
  const logger = mock.method(console, "error", () => {});
  try {
    assert.deepEqual(await completeConnect("workspace-1", "code"), { checked: false, listing: false });
    assert.equal(saved.length, 1);
  } finally {
    logger.mock.restore();
  }
});
