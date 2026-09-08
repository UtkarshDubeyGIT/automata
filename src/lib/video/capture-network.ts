import type { Browser, BrowserContextOptions } from "playwright";
import { assertPublicUrl } from "@/lib/net/public-url";
import { fetchPublicUrl } from "@/lib/net/public-fetch";

/** Generated cards/captions contain their assets inline and need no network. */
export async function createOfflineRenderContext(browser: Browser, options: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  try {
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    await context.routeWebSocket("**/*", (socket) => socket.close());
    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

/** A public-site capture has no access to the worker's private network. */
export async function createPublicCapturePage(browser: Browser, options: BrowserContextOptions) {
  const context = await browser.newContext({ ...options, serviceWorkers: "block" });
  try {
    // A recording does not need persistent socket connections, and Chromium's
    // Fetch domain does not intercept WebSocket handshakes.
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    session.on("Fetch.requestPaused", (event) => {
      void (async () => {
        const allowed = await assertPublicUrl(event.request.url);
        await session.send(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", {
          requestId: event.requestId,
          ...(!allowed ? { errorReason: "BlockedByClient" as const } : {}),
        });
      })().catch(() => session.send("Fetch.failRequest", {
        requestId: event.requestId, errorReason: "BlockedByClient",
      }).catch(() => {}));
    });
    // Playwright intentionally bypasses its route handler after the first hop
    // of a redirect. CDP must be enabled BEFORE navigation to see every hop.
    await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
    await context.route("**/*", async (route) => {
      try {
        const request = route.request();
        if (!(await assertPublicUrl(request.url()))) return await route.abort("blockedbyclient");
        const frame = request.frame();
        if (frame === page.mainFrame()) return await route.continue();
        // Popups are not part of the recording, and can navigate before their
        // own CDP session exists. Child frames may move to a separate Chromium
        // process, so fetch their resources with redirect validation ourselves.
        if (frame.parentFrame() === null) return await route.abort("blockedbyclient");
        const postData = request.postDataBuffer();
        const response = await fetchPublicUrl(request.url(), {
          method: request.method(), headers: await request.allHeaders(),
          body: postData ? new Uint8Array(postData).buffer : undefined,
          signal: AbortSignal.timeout(30_000),
        });
        const headers = Object.fromEntries(response.headers);
        // Fetch has already decoded the body; do not ask Chromium to decode it again.
        delete headers["content-encoding"];
        delete headers["content-length"];
        await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
      } catch {
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    return { context, page };
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}
