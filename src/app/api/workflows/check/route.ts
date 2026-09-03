import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { secretMatches } from "@/lib/secret";
import { drainRuns, reclaimStuckRuns } from "@/lib/workflows/drain";
import { sweepTriggers } from "@/lib/workflows/sweep";

/**
 * Trigger poller — the standalone entry point for an external cron (Vercel
 * cron, GitHub Action, `curl` loop) that only wants to advance workflows.
 *
 * The sweep itself lives in @/lib/workflows/sweep, because the unattended beat
 * (/api/cron) runs it too — and that is the one this box's systemd timer
 * actually calls, so self-firing workflows advance whether or not anything
 * points here.
 *
 * It FAILS CLOSED, the way /api/cron already did. Before, an unset CRON_SECRET
 * skipped the check entirely, which left an unauthenticated endpoint that
 * polls every workspace's providers and starts charged runs open to the
 * internet. GET is gone for the same reason — a link, a crawler or a prefetch
 * should never be able to fire somebody's automations.
 */
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const presented =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!secretMatches(presented, env.cronSecret)) {
    return NextResponse.json(
      { error: env.cronSecret ? "Unauthorized" : "Cron is not configured. Set CRON_SECRET." },
      { status: env.cronSecret ? 401 : 503 },
    );
  }

  // Deliberately tighter than /api/cron's budget: this endpoint is reachable
  // through nginx, whose proxy timeout is 60s. The beat talks to the app on
  // loopback and has 300s, so it is the one that gets the generous deadline.
  const db = createAdminClient();
  const result = await sweepTriggers(db, { deadline: Date.now() + 15_000 });
  // A caller that only sweeps would queue runs nothing ever drives, so this
  // endpoint has to do the whole job the beat does.
  const runs = await drainRuns(db, { deadline: Date.now() + 25_000 });
  const reclaimed = await reclaimStuckRuns(db);
  return NextResponse.json({ ...result, runs, reclaimed, at: new Date().toISOString() });
}
