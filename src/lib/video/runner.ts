/**
 * Starting a generation the moment it is queued, without holding the request.
 *
 * `POST /api/video/generate` debits credits, writes the row and returns 202 — so
 * by design nothing has been generated when the user gets their answer. Two
 * things drive a row forward after that: the browser polling /api/video/status,
 * and the cron sweep. Both are recovery mechanisms rather than starters. The
 * browser only helps while a tab is open, and `zidane-cron.timer` fires every
 * fifteen minutes — PER STEP, so a planned clip that needs planning, keyframing,
 * assembly and narration could sit for the better part of an hour having been
 * paid for in the first second.
 *
 * This module closes that gap: after the response is flushed the route hands the
 * new job ids here, and each one is stepped in-process until it finishes. We are
 * self-hosted on a droplet running one long-lived Node process (see
 * docs/ONBOARDING.md §14), so the loop genuinely outlives the request that
 * started it, which is exactly what "you don't need to keep the tab open" needs.
 *
 * It adds no new way for a generation to complete. Every step still goes through
 * `advanceVideoRow`, still takes the same row-level claims, and is therefore
 * safe to run alongside a polling browser and the sweep. If this process is
 * restarted mid-render the loop dies with it and the sweep picks the row up on
 * the next beat, exactly as it does today.
 */
import { createAdminClient } from "@/lib/supabase/server";
import { supabaseConfigured } from "@/lib/env";
import {
  advanceVideoRow,
  awaitingSubmission,
  jobFromRow,
  pollProvider,
  ROW_COLUMNS,
  MAX_JOB_AGE_MS,
  type VideoRow,
} from "@/lib/video/advance";
import type { VideoJob, VideoKind } from "@/lib/video/higgsfield";

/**
 * How long to wait between steps.
 *
 * The same five seconds the browser polls on would be wasteful here: nothing is
 * watching, and a poll that finds a provider still rendering costs an API call
 * for no information. Ten seconds keeps a finished stage from sitting idle for
 * long while making a ten-minute render about sixty requests rather than a
 * hundred and twenty.
 */
const STEP_INTERVAL_MS = 10_000;

/**
 * Job ids this process is already driving.
 *
 * The row claims stop two WORKERS doing the same step, but a second runner for
 * the same job would still spend the whole render polling the provider and
 * losing claims. One runner per job per process; the set is the whole mechanism.
 */
const running = new Set<string>();

/**
 * Drive these generations to completion in the background. Returns immediately.
 *
 * Deliberately not awaited by callers and deliberately never throws: this is
 * work that has already been paid for and answered for, so a failure here must
 * degrade to "the sweep will get it", never to a rejected promise surfacing as
 * an unhandled rejection in a request that already returned 202.
 */
export function driveVideoJobs(jobIds: string[]): void {
  if (!supabaseConfigured) return;
  for (const id of jobIds) {
    if (!id || running.has(id)) continue;
    running.add(id);
    void drive(id).finally(() => running.delete(id));
  }
}

/** True while this process is stepping that job. Exported for the sweep. */
export function isDriving(jobId: string): boolean {
  return running.has(jobId);
}

async function drive(jobId: string): Promise<void> {
  const startedAt = Date.now();
  const db = createAdminClient();

  // Give the inserting transaction a moment to be visible, then step. Without
  // this the first read can miss its own row and the runner exits before it
  // starts, handing a job that could have begun in a second back to the beat.
  await sleep(500);

  while (Date.now() - startedAt < MAX_JOB_AGE_MS) {
    let done = false;
    try {
      done = await step(db, jobId);
    } catch (err) {
      // One bad step is not a reason to abandon a paid generation — the next
      // pass retries, and the age write-off inside advanceVideoRow is what
      // eventually gives up and refunds.
      console.error(`[video/runner] job ${jobId} step failed:`, err);
    }
    if (done) return;
    await sleep(STEP_INTERVAL_MS);
  }
  console.error(`[video/runner] job ${jobId} still unfinished after the job age limit`);
}

/** One step. Returns true when there is nothing left to do for this job. */
async function step(
  db: ReturnType<typeof createAdminClient>,
  jobId: string,
): Promise<boolean> {
  const { data: row, error } = await db
    .from("videos")
    .select(ROW_COLUMNS)
    .eq("job_id", jobId)
    .maybeSingle<VideoRow>();

  if (error) {
    console.error(`[video/runner] row read failed for ${jobId}:`, error.message);
    return false; // transient by assumption — try again on the next pass
  }
  // No row means nothing to drive: the generation was deleted, or this is a
  // preview-mode id that was never persisted.
  if (!row) return true;
  if (row.status === "completed" || row.status === "failed") return true;

  const kind = (row.kind ?? "ugc") as VideoKind;
  let job: VideoJob;
  try {
    job = awaitingSubmission(row)
      ? jobFromRow(row, jobId, kind)
      : await pollProvider(row.provider_request_id ?? jobId, jobId, kind);
  } catch (err) {
    // Same reasoning as the sweep: a request the provider has forgotten answers
    // 404 forever, and only the age write-off can act on that. Advance on what
    // the row says rather than bailing out and leaving the row stranded.
    console.error(`[video/runner] job ${jobId} poll failed, advancing on age alone:`, err);
    job = {
      id: jobId,
      status: "processing",
      kind,
      prompt: row.prompt ?? "",
      createdAt: row.created_at ?? new Date().toISOString(),
    };
  }

  const next = await advanceVideoRow({ supabase: db, row, job, id: jobId, kind });
  return next.status === "completed" || next.status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
