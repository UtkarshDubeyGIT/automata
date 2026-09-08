import { strict as assert } from "node:assert";
import { createServer, type Server } from "node:http";
import { mock, test } from "node:test";
import { assertPublicUrl as realAssertPublicUrl } from "@/lib/net/public-url";

const fixtureOrigins = new Set(["http://127.0.0.2"]);

// Only the simulated public site is allowlisted. The actual guard still makes
// the decision for loopback, metadata and every other requested destination.
mock.module("@/lib/net/public-url", {
  namedExports: {
    assertPublicUrl: async (raw?: string | null) => {
      if (raw && fixtureOrigins.has(new URL(raw).origin)) return raw;
      return realAssertPublicUrl(raw);
    },
  },
});
mock.module("@/lib/supabase/server", {
  namedExports: {
    createAdminClient: () => ({ storage: { from: () => ({
      upload: async () => ({ error: null }),
      getPublicUrl: () => ({ data: { publicUrl: "https://media.example/fixture.webm" } }),
    }) } }),
  },
});

const { captureShotClip } = await import("@/lib/video/capture");
const { brandTypography } = await import("@/lib/video/fonts");

test("brand fonts cannot follow a public redirect into cloud metadata", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith("http://127.0.0.2/")) {
      if (init?.redirect !== "manual") {
        fetched.push("http://169.254.169.254/latest/meta-data");
        return new Response(Buffer.alloc(600));
      }
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } });
    }
    return new Response(Buffer.alloc(600));
  });
  const typography = await brandTypography({ headingFont: "Fixture", headingFontUrl: "http://169.254.169.254/latest/meta-data" });
  assert.equal(typography.fallback, true);
  assert.deepEqual(fetched, [], "private font destinations must never reach fetch");
  const redirected = await brandTypography({ headingFont: "Fixture", headingFontUrl: "http://127.0.0.2/font.woff2" });
  assert.equal(redirected.fallback, true);
  assert.deepEqual(fetched, ["http://127.0.0.2/font.woff2"]);
});

async function listen(server: Server, host: string, port = 0): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

// Run with AUTOMATA_BROWSER_TESTS=1 and the production Playwright Chromium
// installed. These fixtures never contact the internet or a paid provider.
test("Chromium capture rejects chained redirects, iframe redirects and private subrequests", {
  skip: process.env.AUTOMATA_BROWSER_TESTS !== "1",
}, async () => {
  const privateHits: string[] = [];
  const privateServer = createServer((req, res) => {
    privateHits.push(req.url ?? "");
    res.end("private content that must never be captured");
  });
  privateServer.on("upgrade", (req, socket) => {
    privateHits.push(req.url ?? "");
    socket.destroy();
  });
  const privatePort = await listen(privateServer, "127.0.0.1");
  const privateUrl = `http://127.0.0.1:${privatePort}`;
  let publicPort = 0;
  const publicServer = createServer((req, res) => {
    if (req.url === "/safe-start") {
      res.writeHead(302, { location: "/resources" });
    } else if (req.url === "/start") {
      res.writeHead(302, { location: "/middle" });
    } else if (req.url === "/middle" || req.url === "/iframe") {
      res.writeHead(302, { location: `${privateUrl}/redirect-secret` });
    } else {
      res.setHeader("content-type", "text/html");
      res.end(`<html><body><h1>Public fixture</h1><img src="${privateUrl}/image-secret"><iframe src="http://localhost:${publicPort}/iframe"></iframe><script>fetch('${privateUrl}/fetch-secret').catch(()=>{});new WebSocket('${privateUrl.replace("http:", "ws:")}/ws-secret');</script></body></html>`);
      return;
    }
    res.end();
  });
  try {
    publicPort = await listen(publicServer, "127.0.0.1");
    fixtureOrigins.add(`http://127.0.0.1:${publicPort}`);
    fixtureOrigins.add(`http://localhost:${publicPort}`);
    const input = { aspectRatio: "16:9" as const, workspaceId: "fixture", jobId: "fixture", index: 0, seconds: 0.01 };
    await captureShotClip({ ...input, url: `http://127.0.0.1:${publicPort}/start` }).catch(() => null);
    assert.deepEqual(privateHits, [], "a second redirect hop reached the private server");
    await captureShotClip({ ...input, url: `http://127.0.0.1:${publicPort}/safe-start` });
    assert.deepEqual(privateHits, [], "an image, fetch, iframe or WebSocket reached the private server");
  } finally {
    await Promise.all([privateServer, publicServer].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  }
});
