import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock, test } from "node:test";
import * as openai from "@/lib/ai/openai";

let modelCalls = 0;
mock.module("@/lib/ai/openai", {
  namedExports: { ...openai, chatJSON: async () => {
    modelCalls++;
    return { description: "Public website description" };
  } },
});
mock.module("@/lib/integrations/firecrawl", {
  namedExports: {
    FirecrawlError: class extends Error {},
    runFirecrawl: async () => { throw new Error("No provider call in this test"); },
  },
});

const { analyzeWebsite } = await import("@/lib/ai/analyze");
const { fetchLogo, fetchMusic } = await import("@/lib/video/picture");
const publicOrigin = "http://203.0.113.10";
const privateUrl = "http://169.254.169.254/latest/meta-data";
const content = "This website describes a public product for small teams. ".repeat(50);

test("website analysis fallback refuses private redirects before reading content or calling a model", async (t) => {
  const fetched: string[] = [];
  modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    const target = url.endsWith("/unsafe") ? privateUrl : `${publicOrigin}/content`;
    if (!url.endsWith("/content")) {
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: target } });
      fetched.push(target);
    }
    return new Response(content);
  });
  assert.equal(await analyzeWebsite(`${publicOrigin}/unsafe`), null);
  assert.deepEqual(fetched, [`${publicOrigin}/unsafe`]);
  assert.equal(modelCalls, 0);
  assert.equal((await analyzeWebsite(`${publicOrigin}/safe`))?.description, "Public website description");
  assert.deepEqual(fetched, [`${publicOrigin}/unsafe`, `${publicOrigin}/safe`, `${publicOrigin}/content`]);
  assert.equal(modelCalls, 1);
});

test("video logo and music downloads refuse private URLs and redirect targets without writing files", async (t) => {
  const fetched: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetched.push(url);
    if (url.startsWith(publicOrigin) && !url.endsWith("/safe")) {
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: privateUrl } });
      fetched.push(privateUrl);
    }
    return new Response(Buffer.alloc(2048));
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "automata-download-security-"));
  try {
    assert.equal(await fetchLogo({ brandKit: { logoOverlayUrl: "http://127.0.0.1/private-logo" } }, dir), null);
    assert.equal(await fetchMusic(privateUrl, dir), null);
    assert.deepEqual(fetched, []);
    assert.equal(await fetchLogo({ brandKit: { logoOverlayUrl: `${publicOrigin}/logo` } }, dir), null);
    assert.equal(await fetchMusic(`${publicOrigin}/music`, dir), null);
    assert.deepEqual(fetched, [`${publicOrigin}/logo`, `${publicOrigin}/music`]);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await fetchLogo({ brandKit: { logoOverlayUrl: `${publicOrigin}/safe` } }, dir), path.join(dir, "logo.img"));
    assert.equal(await fetchMusic(`${publicOrigin}/safe`, dir), path.join(dir, "music.audio"));
    assert.deepEqual((await readdir(dir)).sort(), ["logo.img", "music.audio"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
