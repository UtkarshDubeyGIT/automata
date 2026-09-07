#!/usr/bin/env node
/**
 * Run the unattended beat locally, the way the systemd timer runs it in
 * production.
 *
 * /api/cron is what finishes videos when nobody is watching — it sweeps
 * unfinished generations, joins their takes and narrates them. In production a
 * timer calls it; on a dev machine nothing does, so "close the tab and come
 * back" cannot be tested without this.
 *
 *   node scripts/beat.mjs            # every 30s against localhost:3000
 *   node scripts/beat.mjs --once     # a single beat, then exit
 *   node scripts/beat.mjs --every 10 # a different interval, in seconds
 *   node scripts/beat.mjs --url https://... # explicitly target another host
 */
import fs from "node:fs";

const env = {};
for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.CRON_SECRET) {
  console.error("CRON_SECRET is not set in .env.local — /api/cron refuses everything without it.");
  process.exit(1);
}

const args = process.argv.slice(2);
const once = args.includes("--once");
const every = Number(args[args.indexOf("--every") + 1]) || 30;
// Always local unless asked otherwise. NEXT_PUBLIC_APP_URL points at the
// deployed site, and a dev-loop script must never quietly drive production —
// this beat refunds credits and spends money on narration.
const urlFlag = args.indexOf("--url");
const base = urlFlag >= 0 ? args[urlFlag + 1] : "http://localhost:3000";

async function beat() {
  const t0 = Date.now();
  try {
    const res = await fetch(`${base}/api/cron`, {
      method: "POST",
      headers: { "x-cron-secret": env.CRON_SECRET, "Content-Type": "application/json" },
    });
    const body = await res.json().catch(() => null);
    const stamp = new Date().toISOString().slice(11, 19);
    if (!res.ok) {
      console.log(`${stamp}  HTTP ${res.status}  ${JSON.stringify(body)?.slice(0, 160)}`);
      return;
    }
    const v = body?.videos ?? {};
    const w = body?.workflows ?? {};
    const r = body?.workflowRuns ?? {};
    const rec = body?.reclaimed ?? {};
    console.log(
      `${stamp}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ` +
        `videos examined=${v.examined ?? 0} advanced=${v.advanced ?? 0} ` +
        `completed=${v.completed ?? 0} failed=${v.failed ?? 0}  ` +
        // The three workflow passes, so a local run of the beat shows whether
        // a trigger fired, whether the queued run was driven, and whether
        // anything had to be settled.
        `workflows fired=${w.fired ?? 0}/${w.checked ?? 0}` +
        (w.deferred ? ` deferred=${w.deferred}` : "") +
        `  runs driven=${r.driven ?? 0} done=${r.completed ?? 0} ` +
        `failed=${r.failed ?? 0} waiting=${r.waiting ?? 0}` +
        (r.deferred ? ` deferred=${r.deferred}` : "") +
        (rec.failed ? `  reclaimed=${rec.failed} refunded=${rec.refunded ?? 0}` : ""),
    );
  } catch (err) {
    console.log(`${new Date().toISOString().slice(11, 19)}  unreachable: ${err.message}`);
  }
}

console.log(`beat -> ${base}/api/cron ${once ? "(once)" : `every ${every}s`}`);
await beat();
if (!once) setInterval(beat, every * 1000);
