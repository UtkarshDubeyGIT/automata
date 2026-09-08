import assert from "node:assert/strict";
import { mock, test } from "node:test";

mock.module("@/lib/net/public-url", {
  namedExports: {
    assertPublicUrl: async (raw?: string | null) => {
      if (!raw) return null;
      const url = new URL(raw);
      return ["site.example", "cdn.example"].includes(url.hostname) ? url.toString() : null;
    },
  },
});

const { fetchPublicUrl } = await import("@/lib/net/public-fetch");

test("public downloads validate redirected destinations before any private request", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    fetched.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
  });

  await assert.rejects(fetchPublicUrl("http://127.0.0.1/private"), /public HTTP/);
  assert.deepEqual(fetched, []);
  await assert.rejects(fetchPublicUrl("https://site.example/asset", { redirect: "follow" }), /public HTTP/);
  assert.deepEqual(fetched, ["https://site.example/asset"]);
});

test("public downloads follow relative redirects and retain the final asset bytes", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    fetched.push(String(input));
    return fetched.length === 1
      ? new Response(null, { status: 302, headers: { location: "../images/logo.svg" } })
      : new Response("<svg />", { headers: { "content-type": "image/svg+xml" } });
  });

  const result = await fetchPublicUrl("https://site.example/brand/logo");
  assert.equal(await result.text(), "<svg />");
  assert.equal(result.headers.get("content-type"), "image/svg+xml");
  assert.deepEqual(fetched, ["https://site.example/brand/logo", "https://site.example/images/logo.svg"]);
});

test("cross-origin asset redirects do not forward account credentials", async (t) => {
  const headers: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return headers.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://cdn.example/logo.png" } })
      : new Response("image bytes");
  });

  await fetchPublicUrl("https://site.example/logo", {
    headers: { authorization: "Bearer fixture", cookie: "session=fixture", "proxy-authorization": "fixture", host: "site.example", accept: "image/*" },
  });
  assert.equal(headers[0].get("authorization"), "Bearer fixture");
  for (const name of ["authorization", "cookie", "proxy-authorization"]) assert.equal(headers[1].get(name), null);
  assert.equal(headers[1].get("host"), null, "fetch must compute Host for the destination CDN");
  assert.equal(headers[1].get("accept"), "image/*");
});

test("public redirect loops stop within a finite request budget", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 302, headers: { location: "/loop" } });
  });

  await assert.rejects(fetchPublicUrl("https://site.example/loop"), /Too many redirects/);
  assert.ok(requests <= 12, "a redirect loop must not occupy the worker indefinitely");
});
