import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const url = process.env.LANDING_URL;
if (!url) {
  console.error("Set LANDING_URL to a production landing-page URL before running this check.");
  process.exit(2);
}

const mobile = process.env.LANDING_PROFILE === "mobile";
const runCount = Math.min(Math.max(Number(process.env.LANDING_RUNS ?? 3) || 3, 1), 5);
const viewport = mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 };
const artifactDir = process.env.LANDING_ARTIFACT_DIR ?? path.join(os.tmpdir(), "automata-landing-performance");
fs.mkdirSync(artifactDir, { recursive: true });

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function numericMedian(runs, key) {
  return median(runs.map((run) => Number(run[key])));
}

async function runOnce(browser, index) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: mobile ? 2 : 1 });
  const page = await context.newPage();
  const tracePath = path.join(artifactDir, `${mobile ? "mobile" : "desktop"}-run-${index + 1}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true });

  try {
    if (mobile) {
      const client = await context.newCDPSession(page);
      await client.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      await client.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 150,
        downloadThroughput: (1.6 * 1024 * 1024) / 8,
        uploadThroughput: (750 * 1024) / 8,
      });
    }

    await page.addInitScript(() => {
      const state = { lcp: 0, fcp: 0, cls: 0, longTasks: 0 };
      window.__landingVitals = state;
      if ("PerformanceObserver" in window) {
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) {
              if (entry.entryType === "largest-contentful-paint") state.lcp = entry.startTime;
              if (entry.entryType === "paint" && entry.name === "first-contentful-paint") state.fcp = entry.startTime;
              if (entry.entryType === "layout-shift" && !entry.hadRecentInput) state.cls += entry.value;
              if (entry.entryType === "longtask") state.longTasks += 1;
            }
          }).observe({ entryTypes: ["largest-contentful-paint", "paint", "layout-shift", "longtask"] });
        } catch {
          // The navigation/resource timings below remain useful on older Chromium.
        }
      }
    });

    const started = performance.now();
    await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const metrics = await page.evaluate(async () => {
      const frameDeltas = [];
      await new Promise((resolve) => {
        let previous = performance.now();
        let frames = 0;
        const tick = (now) => {
          frameDeltas.push(now - previous);
          previous = now;
          frames += 1;
          if (frames >= 120) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const resources = performance.getEntriesByType("resource");
      const vitals = window.__landingVitals ?? { lcp: 0, fcp: 0, cls: 0, longTasks: 0 };
      const bytes = (predicate) => resources.reduce((sum, entry) => predicate(entry) ? sum + (entry.transferSize || 0) : sum, 0);
      return {
        ...vitals,
        requestCount: resources.length,
        transferBytes: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
        jsBytes: bytes((entry) => entry.initiatorType === "script" || /\.js(?:$|\?)/.test(entry.name)),
        imageBytes: bytes((entry) => entry.initiatorType === "img" || /\.(?:png|jpe?g|gif|webp|avif|svg)(?:$|\?)/i.test(entry.name)),
        frameP95: frameDeltas.sort((a, b) => a - b)[Math.floor(frameDeltas.length * 0.95)] ?? 0,
        framesOver50ms: frameDeltas.filter((delta) => delta > 50).length,
        wallLoadedBeforeScroll: document.querySelector('[data-loaded="true"]') !== null,
      };
    });

    // Target the lazy section itself. Scrolling the document's maximum can
    // leave an observer below the viewport when a page has a tall footer.
    await page.evaluate(() => {
      document.querySelector("[data-loaded]")?.scrollIntoView({ block: "center", behavior: "auto" });
    });
    await page.waitForTimeout(1_200);
    const afterScroll = await page.evaluate(() => {
      const resources = performance.getEntriesByType("resource");
      return {
        wallLoadedAfterScroll: document.querySelector('[data-loaded="true"]') !== null,
        requestCountAfterScroll: resources.length,
        transferBytesAfterScroll: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0),
      };
    });
    const result = {
      run: index + 1,
      navigationMs: Math.round(performance.now() - started),
      ...metrics,
      ...afterScroll,
    };
    const failed = result.lcp > 2_500 || result.cls > 0.1 || !result.wallLoadedAfterScroll;
    await context.tracing.stop(failed ? { path: tracePath } : undefined);
    if (failed) {
      const screenshotPath = path.join(artifactDir, `${mobile ? "mobile" : "desktop"}-run-${index + 1}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      result.artifacts = { screenshot: screenshotPath, trace: tracePath };
    }
    return result;
  } finally {
    await context.close();
  }
}

const browser = await chromium.launch({ headless: true });
const runs = [];
for (let index = 0; index < runCount; index++) runs.push(await runOnce(browser, index));
const browserVersion = browser.version();
await browser.close();

const numericKeys = [
  "lcp", "fcp", "cls", "longTasks", "requestCount", "transferBytes", "jsBytes", "imageBytes",
  "frameP95", "framesOver50ms", "navigationMs", "requestCountAfterScroll", "transferBytesAfterScroll",
];
const medians = Object.fromEntries(numericKeys.map((key) => [key, numericMedian(runs, key)]));
const result = {
  url,
  profile: mobile ? "mobile-390x844-dpr2-cpu4g-network150ms" : "desktop-1440x900",
  browser: { name: "chromium", version: browserVersion },
  hardware: { platform: os.platform(), arch: os.arch(), cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length },
  runCount,
  ...medians,
  wallLoadedBeforeScroll: runs.every((run) => run.wallLoadedBeforeScroll),
  wallLoadedAfterScroll: runs.every((run) => run.wallLoadedAfterScroll),
  runs,
};
console.log(JSON.stringify(result, null, 2));

const baselinePath = process.env.LANDING_BASELINE_JSON;
if (baselinePath) {
  const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  for (const key of ["requestCount", "transferBytes", "jsBytes", "imageBytes"]) {
    if (Number.isFinite(baseline[key]) && result[key] > baseline[key] * 1.1) {
      throw new Error(`${key} regressed by more than 10% (${result[key]} vs baseline ${baseline[key]}).`);
    }
  }
}

if (result.lcp > 2_500 || result.cls > 0.1 || !result.wallLoadedAfterScroll) process.exitCode = 1;
