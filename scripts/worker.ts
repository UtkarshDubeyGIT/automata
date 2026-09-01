import { setTimeout as wait } from "node:timers/promises";

import { createClient } from "@supabase/supabase-js";

import { sweepDueSchedules } from "@/lib/workflows/schedule-runner";
import { cleanupExpiredRuns } from "@/lib/workflows/retention";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY before starting the worker.");
const admin = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const once = process.env.WORKER_ONCE === "1";
const interval = Math.max(5_000, Number(process.env.WORKER_POLL_MS ?? 15_000));
let lastCleanup = 0;

do {
  try {
    const runs = await sweepDueSchedules(admin);
    if (runs.length) console.info(`[automata-worker] processed ${runs.length} due workflow(s)`);
    if (Date.now() - lastCleanup > 3_600_000) { await cleanupExpiredRuns(admin); lastCleanup = Date.now(); }
  } catch (error) {
    console.error("[automata-worker] sweep failed", error);
  }
  if (!once) await wait(interval);
} while (!once);
