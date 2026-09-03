import { setTimeout as wait } from "node:timers/promises";

// The sweep lives behind POST /api/cron so the worker and any external scheduler
// share one implementation. Driving it over HTTP also keeps this script out of the
// Next-only module graph, which the strip-types loader cannot resolve.
const secret = process.env.CRON_SECRET;
if (!secret) throw new Error("Set CRON_SECRET before starting the worker.");

const target = `${(process.env.WORKER_TARGET_URL ?? "http://web:3000").replace(/\/$/, "")}/api/cron`;
const once = process.env.WORKER_ONCE === "1";
const interval = Math.max(5_000, Number(process.env.WORKER_POLL_MS ?? 15_000));

do {
  try {
    const res = await fetch(target, {
      method: "POST",
      headers: { "x-cron-secret": secret },
    });
    const body = await res.text();
    if (!res.ok) console.error(`[automata-worker] sweep returned ${res.status}: ${body.slice(0, 500)}`);
    else console.info(`[automata-worker] ${body.slice(0, 500)}`);
  } catch (error) {
    console.error("[automata-worker] sweep failed", error);
  }
  if (!once) await wait(interval);
} while (!once);
