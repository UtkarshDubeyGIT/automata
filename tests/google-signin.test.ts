import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * Google sign-in was a stub that always bounced to `?notice=google_disabled`.
 * Now that it really calls the provider, the things worth pinning are the ones
 * a manual click-through will not show: that a hostile `?next=` cannot ride
 * along to an off-site destination, and that a switched-off provider says so
 * instead of sending the browser to a blank consent page.
 */

/** `redirect()` throws NEXT_REDIRECT in Next; model that so control flow matches. */
class Redirected extends Error {
  url: string;
  constructor(url: string) {
    super("NEXT_REDIRECT");
    this.url = url;
  }
}

mock.module("next/navigation", {
  namedExports: {
    redirect: (url: string) => {
      throw new Redirected(url);
    },
  },
});

// The Origin header is deliberately wrong here: behind the proxy the callback
// has to be built from the configured public URL, not from what the request
// claims, or the code comes back to a host the browser cannot reach.
mock.module("next/headers", {
  namedExports: {
    headers: async () => new Headers({ origin: "https://localhost:3000" }),
  },
});

mock.module("@/lib/env", {
  namedExports: { env: { appUrl: "https://automata.doubtbuddy.com" } },
});

let oauth: { url: string | null; error: { code?: string; status?: number } | null } = {
  url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test",
  error: null,
};
let lastOptions: { redirectTo?: string } | undefined;

mock.module("@/lib/supabase/server", {
  namedExports: {
    createServerSupabaseClient: async () => ({
      auth: {
        signInWithOAuth: async (args: { provider: string; options?: { redirectTo?: string } }) => {
          lastOptions = args.options;
          return { data: { url: oauth.url, provider: args.provider }, error: oauth.error };
        },
      },
    }),
  },
});

mock.module("@/lib/supabase/config", {
  namedExports: { isSupabaseConfigured: () => true },
});

const { signInWithGoogle } = await import("@/app/(auth)/actions");

async function start(next: string): Promise<string> {
  const form = new FormData();
  form.set("next", next);
  try {
    await signInWithGoogle(form);
  } catch (error) {
    if (error instanceof Redirected) return error.url;
    throw error;
  }
  assert.fail("expected a redirect");
}

test("sends the browser to the provider's consent screen", async () => {
  oauth = { url: "https://accounts.google.com/o/oauth2/v2/auth?client_id=test", error: null };
  assert.equal(await start("/app/workflows"), oauth.url);
});

test("carries the requested destination through the callback", async () => {
  await start("/app/workflows");
  assert.equal(
    lastOptions?.redirectTo,
    "https://automata.doubtbuddy.com/auth/callback?next=%2Fapp%2Fworkflows",
  );
});

test("an attacker-supplied next never leaves the origin", async () => {
  for (const hostile of ["//evil.example", "https://evil.example/steal", "/\\evil.example"]) {
    await start(hostile);
    assert.equal(
      lastOptions?.redirectTo,
      "https://automata.doubtbuddy.com/auth/callback?next=%2Fapp",
      `${hostile} was not clamped`,
    );
  }
});

test("a disabled provider explains itself instead of redirecting nowhere", async () => {
  oauth = { url: null, error: { code: "validation_failed", status: 400 } };
  assert.equal(await start("/app"), "/login?notice=google_disabled");
});
