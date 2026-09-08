import { randomUUID } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { env, supabaseConfigured } from "@/lib/env";
import { secretMatches } from "@/lib/secret";
import { claimJob } from "@/lib/jobs/lock";
import { drainRuns, reclaimStuckRuns, resumeRenders } from "@/lib/workflows/drain";
import { sweepTriggers } from "@/lib/workflows/sweep";
import { kickWorkflowBuilds, type BuildJobDb } from "@/lib/workflows/build-jobs";
import { drainWhatsAppDeliveries } from "@/lib/whatsapp/service";
import { setupNotice } from "@/lib/setup-notice";
import { sweepVideos } from "@/lib/video/advance";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

// Vercel cron invokes GET; the VM worker invokes POST. Both use the same
// authenticated, lock-protected execution path.
export async function GET(req: NextRequest) {
  return POST(req);
}

export async function POST(req: NextRequest) {
  if (!env.cronSecret) {
    return NextResponse.json(
      {
        error: setupNotice(
          "Scheduled runs are not available.",
          "Cron is not configured. Set CRON_SECRET.",
        ),
      },
      { status: 503 },
    );
  }
  const presented =
    req.headers.get("x-cron-secret") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    "";
  if (!secretMatches(presented, env.cronSecret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!supabaseConfigured) {
    return NextResponse.json({ error: "Supabase is not configured." }, { status: 503 });
  }

  const db = createAdminClient();

  let workflowBuilds = { examined: 0, completed: 0, failed: 0, deferred: 0 };
  try {
    workflowBuilds = await kickWorkflowBuilds(db as unknown as BuildJobDb);
  } catch (err) {
    console.error("[cron] workflow build drain failed:", err);
  }

  let workflows: unknown = { swept: 0, checked: 0, fired: 0, deferred: 0 };
  let workflowRuns: unknown = { examined: 0, driven: 0, completed: 0, failed: 0, waiting: 0, deferred: 0 };
  let workflowResumes: unknown = { checked: 0, resumed: 0, completed: 0, failed: 0, stillWaiting: 0 };
  let workflowReclaims: unknown = { examined: 0, settled: 0, refunded: 0 };
  let whatsapp: unknown = { examined: 0, sent: 0, failed: 0, retried: 0 };
  let videos: unknown = { examined: 0, advanced: 0, completed: 0, failed: 0 };

  const beatClaim = await claimJob(db, "workflow-beat", 5 * 60_000, randomUUID());
  if (beatClaim.ok) {
    try {
      workflows = await sweepTriggers(db, { deadline: Date.now() + 45_000 });
      workflowResumes = await resumeRenders(db, { deadline: Date.now() + 30_000 });
      workflowRuns = await drainRuns(db, { deadline: Date.now() + 60_000 });
      workflowReclaims = await reclaimStuckRuns(db);
      whatsapp = await drainWhatsAppDeliveries();
    } catch (err) {
      console.error("[cron] workflow beat failed:", err);
    } finally {
      await beatClaim.release();
    }
  }

  // Video rendering has its own row leases and can outlast the workflow beat.
  // It must not hold that lock or block the bounded workflow drain on failure.
  try {
    videos = await sweepVideos();
  } catch (error) {
    console.error("[cron] video sweep failed:", error);
  }

  return NextResponse.json({
    ok: true,
    workflowBuilds,
    workflows,
    workflowResumes,
    workflowRuns,
    workflowReclaims,
    whatsapp,
    videos,
  });
}
