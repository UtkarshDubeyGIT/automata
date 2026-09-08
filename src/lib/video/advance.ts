/**
 * Driving a video generation forward, independent of who is asking.
 *
 * This used to live inside the GET handler of /api/video/status, which meant a
 * clip only advanced while a browser was polling it. Takes render at the
 * provider whether or not anyone is watching, but mirroring them, cutting them
 * together and narrating the result all happened here — so closing the tab left
 * a set of finished, paid-for takes with nothing to join them.
 *
 * The logic was already parameterized by its Supabase client, so it moved
 * unchanged. What is new is that there are now two callers: the poll (RLS
 * client, one row, the caller's own) and the unattended sweep (service role,
 * every row that still has work). One implementation, so the two can never
 * drift into finishing clips differently.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  videoProvider,
  segmentsForDuration,
  isAspectRatio,
  assembledSeconds,
  specForKind,
  promptForTake,
  submitTake,
  PROVIDER_CREDITS_PER_TAKE,
  type VideoKind,
  type VideoJob,
} from "@/lib/video/higgsfield";
import { buildPlan, type Shot, type VideoPlan } from "@/lib/video/plan";
import { awaitingCapture, captureStep } from "@/lib/video/capture-step";
import { visualBrief } from "@/lib/video/brief";
import { buildKeyframes } from "@/lib/video/keyframes";
import { validateKeyframe, validateRenderedShot, type Verdict } from "@/lib/video/validate";
import { captureShotClip } from "@/lib/video/capture";
import { archiveVideoRow } from "@/lib/video/archive";
import { addVoiceover } from "@/lib/video/postproduce";
import {
  storeTake,
  concatTakes,
  parseTakes,
  renderedTakes,
  pendingTakes,
  isLocalTake,
  type Take,
} from "@/lib/video/stitch";
import { missingMediaTools } from "@/lib/video/postproduce";
import { createAdminClient } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { getBrandProfileForWorkspace, brandVideoHint, type BrandProfile } from "@/lib/brand";
import { grantCredits, CREDIT_COST } from "@/lib/credits";
import { videoCreditCost } from "@/lib/video/higgsfield";
import { CONTENT_TONES, type ContentTone } from "@/lib/ai/content";
/**
 * How long a narration claim is honoured before another poll may take it over.
 * Covers the worst-case run above with headroom; its only job is to stop a
 * process that died mid-narration from parking the clip as silent forever.
 */
const CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * Same idea for the assembly claim. Shorter, because an assembly step is a few
 * downloads and one ffmpeg pass — minutes, not a paid pipeline.
 */
const ASSEMBLY_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * How many times one shot may be submitted before we accept what came back.
 *
 * Two: the original and one retry. A third attempt animates the same keyframe
 * with the same prompt and expects a different answer, while costing another 9
 * provider credits and up to nine more minutes of the user's wait. A shot that
 * fails twice ships as it is, and the take's `validation` record on the row
 * says what was wrong with it.
 */
const MAX_SHOT_ATTEMPTS = 2;

/**
 * How long a generation may stay unfinished before it is written off.
 *
 * Nothing gave up before this. A take that the provider never resolves — hung,
 * expired, or answering 404 to a request id it has forgotten — left the row
 * "processing" for good: the browser polled it every five seconds forever, each
 * poll asked the provider again, and the credits stayed spent on a clip that
 * was never going to arrive.
 *
 * The ceiling is deliberately far above any real render. Takes run in parallel,
 * so a clip costs about as long as its slowest take — 4-9 minutes — no matter
 * whether it is one take or the eight-take maximum. Three quarters of an hour
 * is therefore not a deadline anything legitimate can miss; it is the point at
 * which "still rendering" has stopped being a plausible explanation.
 */
export const MAX_JOB_AGE_MS = 45 * 60 * 1000;

/** Columns the handling below needs, read once per request. */
export const ROW_COLUMNS =
  "id, workspace_id, prompt, url, thumbnail_url, voiced_url, voiced_duration_sec, " +
  "voiceover_status, target_duration_sec, provider_request_id, provider_prompt, " +
  "segments, assembly_status, tone, kind, status, created_at, target_takes, job_id, " +
  "aspect_ratio, plan, plan_status, keyframe_status, pipeline, metrics, brand_snapshot";

export interface VideoRow {
  id: string;
  /**
   * The client-facing id. The poll route takes this from the query string; the
   * sweep has only the row, so it has to be selected.
   */
  job_id: string | null;
  workspace_id: string | null;
  prompt: string | null;
  url: string | null;
  thumbnail_url: string | null;
  voiced_url: string | null;
  voiced_duration_sec: number | null;
  voiceover_status: string | null;
  target_duration_sec: number | null;
  provider_request_id: string | null;
  provider_prompt: string | null;
  segments: unknown;
  assembly_status: string | null;
  /**
   * Takes decided at generate time. NULL on rows written before the column,
   * which fall back to deriving the count from the requested length.
   */
  target_takes: number | null;
  /** Tone chosen at generate time; null lets the script model choose. */
  tone: ContentTone | null;
  /**
   * Format chosen at generate time. Read here because assembly is what makes
   * it true — the cut is conformed to these dimensions (see stitch.ts). Before
   * that it was written at generate time and never read again, which is why a
   * clip could come back in any shape the models felt like.
   */
  aspect_ratio: string | null;
  kind: string | null;
  status: string | null;
  created_at: string | null;

  // ---- v2 pipeline (migration 0016). NULL on every v1 row. ----

  /**
   * The plan document. Seeded at insert with `{ inputs: {...} }` — the request
   * fields planning needs but the row has nowhere else to keep, since POST now
   * returns before any of them are used — and merged with the script, critique,
   * style anchor and shot list once planning runs.
   */
  plan: unknown;
  plan_status: string | null;
  keyframe_status: string | null;
  /** 'v2' drives the planned pipeline; anything else is the original path. */
  pipeline: string | null;
  /** Measured cost/latency/retries, for repricing against real numbers. */
  metrics: unknown;
  /**
   * The brand this clip is being made for, frozen when it was queued.
   *
   * Read in preference to the live workspace profile at every stage — see
   * `brandFor` and migration 0017.
   */
  brand_snapshot: unknown;
}

/**
 * The brand to render this row with.
 *
 * The snapshot wins whenever there is one. A generation runs for ten to fifteen
 * minutes across four stages, each of which used to re-read the workspace
 * profile independently — so editing the logo or rescanning the site mid-render
 * produced a clip composed for one brand and finished as another. The live read
 * remains for rows written before snapshots existed and for the original
 * pipeline.
 */
async function brandFor(row: VideoRow): Promise<BrandProfile | null> {
  const snap = row.brand_snapshot;
  if (snap && typeof snap === "object") return snap as BrandProfile;
  return row.workspace_id ? getBrandProfileForWorkspace(row.workspace_id) : null;
}

/** The request inputs a v2 row carries forward into planning. */
interface PlanInputs {
  assetUrl?: string | null;
  productUrl?: string | null;
}

/** Read the seeded inputs back off the plan document, defensively. */
function planInputs(plan: unknown): PlanInputs {
  if (!plan || typeof plan !== "object") return {};
  const inputs = (plan as { inputs?: unknown }).inputs;
  if (!inputs || typeof inputs !== "object") return {};
  const i = inputs as PlanInputs;
  return {
    assetUrl: typeof i.assetUrl === "string" ? i.assetUrl : null,
    productUrl: typeof i.productUrl === "string" ? i.productUrl : null,
  };
}

/** Read the stored plan back, or null when planning has not produced one. */
function storedPlan(plan: unknown): VideoPlan | null {
  if (!plan || typeof plan !== "object") return null;
  const p = plan as Partial<VideoPlan>;
  if (!Array.isArray(p.shots) || p.shots.length === 0) return null;
  return {
    script: typeof p.script === "string" ? p.script : "",
    cta: typeof p.cta === "string" ? p.cta : "",
    critique: typeof p.critique === "string" ? p.critique : "",
    considered: typeof p.considered === "number" ? p.considered : 0,
    styleAnchor: typeof p.styleAnchor === "string" ? p.styleAnchor : "",
    shots: p.shots as VideoPlan["shots"],
  };
}

/**
 * Merge a patch into the row's metrics without losing what earlier steps
 * recorded. Read-modify-write on a jsonb column with several sequential
 * writers — safe here only because the steps are serialized by their own
 * claims, so two of them never write metrics at the same time.
 */
async function recordMetrics(
  supabase: SupabaseClient,
  rowId: string,
  patch: Record<string, unknown>,
  /**
   * Keys to ADD to whatever is already stored rather than replace.
   *
   * Re-renders happen in separate assembly passes, and a plain merge meant the
   * second pass overwrote the first pass's count. Measured on a real run: four
   * provider submissions actually made, `shotRerenders: 1` recorded, and the
   * cost line therefore reported 27 credits against an actual 36. A metric
   * that under-reports spend is worse than no metric, because repricing will
   * be done against it.
   */
  accumulate: string[] = [],
): Promise<void> {
  try {
    const { data } = await supabase
      .from("videos")
      .select("metrics")
      .eq("id", rowId)
      .maybeSingle<{ metrics: unknown }>();
    const current =
      data?.metrics && typeof data.metrics === "object"
        ? (data.metrics as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = { ...current, ...patch };
    for (const key of accumulate) {
      const before = typeof current[key] === "number" ? (current[key] as number) : 0;
      const delta = typeof patch[key] === "number" ? (patch[key] as number) : 0;
      merged[key] = before + delta;
    }
    await supabase.from("videos").update({ metrics: merged }).eq("id", rowId);
  } catch (err) {
    // Metrics are for us, not for the user. Never let them fail a generation.
    console.error("[video/advance] metrics write failed:", err);
  }
}

/** True for URLs already inside our own Supabase Storage. */
function isOurs(url: string | null | undefined): boolean {
  return !!url && !!env.supabaseUrl && url.startsWith(env.supabaseUrl);
}

/**
 * Perform at most ONE step of work on a generation, and report where it got to.
 *
 * At most one because the browser polls every 5s without awaiting the previous
 * request, and every step here costs real bandwidth, CPU and provider calls.
 * Steps are claimed with conditional UPDATEs, so overlapping callers — two
 * polls, or a poll racing the sweep — serialize at the row level rather than
 * each running their own ffmpeg pass over the same clip.
 */
export async function advanceVideoRow(input: {
  supabase: SupabaseClient;
  row: VideoRow | null;
  job: VideoJob;
  id: string;
  kind: VideoKind;
}): Promise<VideoJob> {
  const { supabase, row, id, kind } = input;
  let job = input.job;

  // Give up on a generation too old to still be plausible — but salvage before
  // discarding. Takes that already rendered are paid-for work sitting in
  // storage, so the pending ones are marked failed and the assembly path below
  // cuts together whatever came back and refunds only the difference. Writing
  // the whole clip off would throw away finished renders AND the wait.
  if (row?.workspace_id && row.status !== "completed" && row.status !== "failed") {
    const startedAt = row.created_at ? Date.parse(row.created_at) : NaN;
    if (Number.isFinite(startedAt) && Date.now() - startedAt > MAX_JOB_AGE_MS) {
      const takes = parseTakes(row.segments);
      const salvageable = renderedTakes(takes);
      const stalled = pendingTakes(takes);

      if (salvageable.length > 0 && stalled.length > 0) {
        for (const take of stalled) take.failed = true;
        await supabase.from("videos").update({ segments: takes }).eq("id", row.id);
        console.error(
          `[video/advance] job ${id} timed out with ${salvageable.length}/${takes.length} takes — cutting what landed`,
        );
        // Fall through: the assembly branch now sees a complete set and joins it.
      } else if (salvageable.length === 0) {
        // Said in words on the row, not only in the log: nobody is waiting on a
        // response by the time this fires, so the panel has nowhere else to
        // learn why a clip it queued an hour ago never arrived.
        const message = "This generation took too long and was written off — your credits were refunded.";
        const { data: firstToExpire } = await supabase
          .from("videos")
          .update({
            status: "failed",
            assembly_status: "done",
            assembly_claimed_at: null,
            plan: { ...(row.plan && typeof row.plan === "object" ? row.plan : {}), error: message },
          })
          .eq("id", row.id)
          .neq("status", "failed")
          .select("id");
        if (firstToExpire?.length) {
          const total = takes.length || segmentsNeeded(row) || 1;
          await refundTakes({
            row,
            takesLost: total,
            takesTotal: total,
            reason: "video_timed_out",
          });
        }
        console.error(`[video/advance] job ${id} exceeded ${MAX_JOB_AGE_MS}ms — written off`);
        return { ...job, status: "failed", error: message };
      }
    }
  }

  // ---- The steps that PRODUCE the footage, before anything can be finished. --
  //
  // Placed AFTER the age write-off on purpose: a row stuck in any of them must
  // still be given up on and refunded like any other, and the write-off above
  // handles a row with no takes correctly (nothing salvageable, full refund).
  //
  // Each step owns its own claim and does at most one step per call, exactly
  // like assembly and narration below — so a browser polling every 5s and the
  // sweep running concurrently cannot both plan the same clip.

  // A product demo records a URL rather than generating anything, so its
  // footage step is a capture. It used to happen inside the POST that charged
  // for it, which is why closing the tab killed a paid demo mid-recording.
  if (awaitingCapture(row)) {
    return await captureStep({ supabase, row: row!, job, id });
  }

  // The original pipeline submitted to the provider inside the POST as well.
  // Queued rows now carry the inputs and this does the submitting, so v1 and v2
  // answer the same way: the row is the job, and the request only wrote it.
  if (
    row?.workspace_id &&
    row.pipeline === "v1" &&
    !row.provider_request_id &&
    row.status !== "completed" &&
    row.status !== "failed"
  ) {
    return await submitStep({ supabase, row, job, id, kind });
  }

  if (
    row?.workspace_id &&
    row.pipeline === "v2" &&
    row.status !== "completed" &&
    row.status !== "failed"
  ) {
    if (row.plan_status !== "done") {
      return await planStep({ supabase, row, job, id });
    }
    if (row.keyframe_status !== "done") {
      return await keyframeStep({ supabase, row, job, id, kind });
    }
  }

  // A generated clip in progress: assemble it instead of settling for take 0.
  //
  // The gate used to be `segmentsNeeded(row) > 1`, so a single-take clip
  // skipped assembly entirely and was served as whatever the provider returned.
  // That is the path that made FORMAT a suggestion: conforming to the chosen
  // dimensions happens during the join, so the one clip length that never
  // joined was also the one that never got the format it was asked for. Any row
  // carrying takes now goes through the same step — for a single take that is
  // one short encode, and it buys a clip that is the shape it was sold as.
  //
  // Demos have no `segments` (they are a Playwright capture, already recorded
  // at the exact viewport) and so still skip this, as they should.
  //
  // `status !== "completed"` matters specifically because of the widened gate.
  // Multi-take rows were always protected from re-assembly by
  // `assembly_status === "done"`, but single-take rows finished on the path
  // below and so carry `assembly_status = null` forever. Without this check,
  // polling one of those after the change would re-cut it and overwrite `url`
  // with a freshly conformed SILENT cut — while `narrate` correctly declined to
  // redo the narration it had already paid for, leaving the voiced file
  // orphaned in storage and the row pointing at a clip with no audio.
  //
  // Assembly is ffmpeg all the way down. On a host without it there is nothing
  // to assemble with, so the clip falls back to the single take we already have
  // — a shorter video is a far better outcome than a job that retries an
  // impossible step forever and never completes.
  if (
    row?.workspace_id &&
    row.status !== "completed" &&
    parseTakes(row.segments).length > 0
  ) {
    const toolsMissing = await missingMediaTools();
    if (toolsMissing) {
      // Not just long clips any more — every generated clip is assembled, and
      // assembly is also where the chosen format is applied. Without ffmpeg the
      // take ships as the provider returned it: right content, unconformed
      // shape. Loud, because that is a promise the UI has already made.
      console.error(
        "[video/advance] cannot assemble or conform clip — shipping the raw take:",
        toolsMissing,
      );
    } else {
      return await assembleTakes({ supabase, row, job, id, kind });
    }
  }

  if (job.status === "completed" || job.status === "failed") {
    // Refund BEFORE mirroring, while `row` still holds the pre-failure status.
    // The conditional update is the payout guard: exactly one caller can move a
    // row into "failed", and only that one refunds. Later callers see a provider
    // still reporting failure, match zero rows here, and pay nothing again.
    if (job.status === "failed" && row?.workspace_id && row.status !== "failed") {
      const message = "The video provider couldn't finish this render — your credits were refunded.";
      job = { ...job, error: job.error ?? message };
      const { data: firstToFail } = await supabase
        .from("videos")
        .update({
          status: "failed",
          plan: { ...(row.plan && typeof row.plan === "object" ? row.plan : {}), error: message },
        })
        .eq("id", row.id)
        .neq("status", "failed")
        .select("id");
      if (firstToFail?.length) {
        // Count the takes actually submitted. segmentsNeeded re-derives the
        // count from the stored LABEL, which is a lossy record of it.
        const submitted = parseTakes(row.segments);
        const total = submitted.length || segmentsNeeded(row) || 1;
        await refundTakes({
          row,
          takesLost: total,
          takesTotal: total,
          reason: "video_provider_failed",
        });
      }
    }

    job = await mirror({ supabase, row, job, id });

    // Copy the finished file into our own storage so history outlives the
    // provider's CDN. Returns our permanent URL when it succeeds.
    if (job.status === "completed" && job.url) {
      if (!isOurs(job.url)) {
        const archived = await archiveVideoRow(id);
        if (archived) job = { ...job, url: archived };
      }

      job = await narrate({ supabase, row, job, id, kind });
    }
  }

  // A failure that some earlier pass recorded still has to explain itself to
  // this one: only the caller that moved the row into "failed" holds the reason
  // in hand, and every poll after it reads the row instead.
  if (job.status === "failed" && !job.error && row) {
    const recorded = rowError(row);
    if (recorded) job = { ...job, error: recorded };
  }

  return job;
}

/**
 * Advance every generation that still has work outstanding, for every
 * workspace. This is what makes "close the tab and come back" true.
 *
 * Deliberately OUTSIDE the autonomy gate the rest of the beat sits behind.
 * That gate governs the agent acting on someone's behalf — publishing to their
 * audience, spending their budget. Finishing a clip is neither: the user asked
 * for it, was charged for it, and the takes are already rendered. Refusing to
 * assemble those until they opt into unattended running would just strand paid
 * work.
 *
 * Rows are taken oldest-first and capped per run, because each one can mean
 * several downloads and an ffmpeg pass. The cap is a fairness device, not a
 * limit on what completes: whatever does not fit is picked up on the next beat,
 * and the claims mean a row already being driven by an open tab is skipped
 * rather than duplicated.
 */
export async function sweepVideos(limit = 10): Promise<{
  examined: number;
  advanced: number;
  completed: number;
  failed: number;
}> {
  const db = createAdminClient();
  const { data: rows, error } = await db
    .from("videos")
    .select(ROW_COLUMNS)
    .in("status", ["queued", "processing"])
    // `provider_request_id` is deliberately NOT required here. A planned row
    // has none until keyframing submits its takes, and it is precisely those
    // rows the sweep has to pick up — they are the ones with the most work
    // outstanding and nobody else to do it if the tab is closed.
    .not("job_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<VideoRow[]>();

  if (error) {
    console.error("[video/sweep] row read failed:", error.message);
    return { examined: 0, advanced: 0, completed: 0, failed: 0 };
  }

  const out = { examined: rows?.length ?? 0, advanced: 0, completed: 0, failed: 0 };
  for (const row of rows ?? []) {
    const jobId = row.job_id;
    if (!jobId) continue;
    const kind = (row.kind ?? "ugc") as VideoKind;
    try {
      let job: VideoJob;
      try {
        // Same reasoning as the poll route: a planned row has nothing at the
        // provider until keyframing submits its takes.
        job = awaitingSubmission(row)
          ? jobFromRow(row, jobId, kind)
          : await pollProvider(row.provider_request_id ?? jobId, jobId, kind);
      } catch (err) {
        // A provider that has forgotten this request answers 404 to it forever.
        // Bailing out here would skip advanceVideoRow, and with it the age
        // write-off that exists for exactly this case — so the row would stay
        // "processing" permanently, unrefunded, occupying one of this sweep's
        // slots on every beat. Ten of them would starve the pipeline for
        // everyone. Advance on what the ROW says instead: only the age check
        // can act on a job we could not poll, and by 45 minutes a transient
        // provider blip has long since resolved.
        console.error(`[video/sweep] job ${jobId} poll failed, advancing on age alone:`, err);
        job = {
          id: jobId,
          status: "processing",
          kind,
          prompt: row.prompt ?? "",
          createdAt: row.created_at ?? new Date().toISOString(),
        };
      }
      const next = await advanceVideoRow({ supabase: db, row, job, id: jobId, kind });
      out.advanced += 1;
      if (next.status === "completed") out.completed += 1;
      if (next.status === "failed") out.failed += 1;
    } catch (err) {
      // One bad row must not stop the sweep for every other workspace.
      console.error(`[video/sweep] job ${jobId} failed to advance:`, err);
    }
  }
  return out;
}

/**
 * Give back credits for takes that were paid for and never delivered.
 *
 * The generate route already refuses to bill for undelivered work — a provider
 * that rejects the request is refunded there. But a video provider does not
 * fail at submission time, it fails MINUTES LATER, and by then the request that
 * charged for it has long returned. Every one of those failures surfaced here
 * instead, where nothing refunded anything: the row was marked failed, the user
 * saw "failed", and the credits were simply gone.
 *
 * The refund is proportional because a partly-failed long clip is still
 * delivered: six takes were paid for, three rendered, so three takes' worth
 * comes back and the user keeps a 15-second clip. That falls out of duration
 * pricing — takes are what a clip is billed in, so takes are what it is
 * refunded in.
 *
 * Best-effort and never throws: a refund that fails must not turn a failed
 * render into a failed request.
 */
async function refundTakes(input: {
  row: VideoRow;
  takesLost: number;
  takesTotal: number;
  reason: string;
}): Promise<void> {
  const { row, takesLost, takesTotal, reason } = input;
  if (!row.workspace_id || takesLost <= 0 || takesTotal <= 0) return;

  const kind = (row.kind ?? "ugc") as VideoKind;
  const listedPrice = CREDIT_COST[`video_${kind}` as keyof typeof CREDIT_COST];
  if (typeof listedPrice !== "number") return;

  // What ONE row cost. Variations are separate rows with their own job ids, so
  // a row is refunded for itself and never for its siblings.
  const paid = videoCreditCost({
    listedPrice,
    kind,
    durationSec: row.target_duration_sec,
    count: 1,
  });
  const amount = takesLost >= takesTotal ? paid : Math.round((paid * takesLost) / takesTotal);
  if (amount <= 0) return;

  try {
    await grantCredits(row.workspace_id, amount, "refund", reason);
  } catch (err) {
    console.error("[video/advance] refund failed:", err);
  }
}

/**
 * A job state built from the row alone, with no provider call.
 *
 * Needed because a v2 row exists BEFORE anything has been submitted: POST
 * returns 202 having only written the row, and planning and keyframing run
 * later. Polling in that window would ask the provider about `vid_<uuid>` —
 * an id it has never seen — which 404s, logs an error, and does so again on
 * every five-second poll for the couple of minutes planning takes.
 */
export function jobFromRow(row: VideoRow, id: string, kind: VideoKind): VideoJob {
  // A demo is finished by a capture rather than by a provider, so "completed"
  // is a state this function has to be able to report — and a demo that has its
  // file IS complete, whatever the row still says. That is what hands a fresh
  // capture to the shared terminal path below, where it gets mirrored and
  // narrated exactly like any other clip instead of needing its own ending.
  const captured = row.kind === "demo" && !!row.url;
  const status: VideoJob["status"] =
    row.status === "failed"
      ? "failed"
      : row.status === "completed" || captured
        ? "completed"
        : "processing";
  return {
    id,
    status,
    kind,
    prompt: row.prompt ?? "",
    url: row.url ?? undefined,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    durationSec: row.voiced_duration_sec ?? row.target_duration_sec ?? undefined,
    aspectRatio: isAspectRatio(row.aspect_ratio) ? row.aspect_ratio : undefined,
    createdAt: row.created_at ?? new Date().toISOString(),
    progress: { done: 0, total: row.target_takes ?? segmentsForDuration(row.target_duration_sec ?? 0) },
    ...(status === "failed" ? { error: rowError(row) } : {}),
    ...(brandKitSavedBy(row.plan) ? { brandKitSaved: true } : {}),
  };
}

/** Did this row's capture rewrite the workspace brand kit? Demos only. */
function brandKitSavedBy(plan: unknown): boolean {
  if (!plan || typeof plan !== "object") return false;
  return (plan as { brandKitSaved?: unknown }).brandKitSaved === true;
}

/**
 * True while a row has no provider request to ask about yet.
 *
 * Three kinds of row qualify now that every path returns 202 before doing any
 * work: a planned clip before keyframing submits its takes, a v1 clip before
 * `submitStep` creates it, and a product demo, which never has a provider
 * request at all. Asking the provider about the local job id would 404 on every
 * poll for the whole window — which is minutes of logged errors, and for a demo
 * would be forever.
 *
 * Rows written before any of this have `provider_request_id` set at insert, so
 * they are unaffected.
 */
export function awaitingSubmission(row: VideoRow | null | undefined): boolean {
  return !!row && !row.provider_request_id;
}

/** The narration concept a step ground in what was actually recorded, if any. */
function narrationPromptOf(plan: unknown): string | null {
  if (!plan || typeof plan !== "object") return null;
  const value = (plan as { narrationPrompt?: unknown }).narrationPrompt;
  return typeof value === "string" && value.trim() ? value : null;
}

/** The failure reason recorded on a row, when a step wrote one. */
function rowError(row: VideoRow): string | undefined {
  const plan = row.plan;
  if (!plan || typeof plan !== "object") return undefined;
  const message = (plan as { error?: unknown }).error;
  return typeof message === "string" && message ? message : undefined;
}

/** Poll one provider request, reported under the client-facing job id. */
export async function pollProvider(
  providerId: string,
  jobId: string,
  kind: VideoKind,
): Promise<VideoJob> {
  const job = await videoProvider.status(providerId, kind);
  return { ...job, id: jobId };
}

/**
 * How many takes this row's clip is made of.
 *
 * The recorded count wins. Deriving it from `target_duration_sec` is a
 * fallback for rows written before that column existed, and a lossy one:
 * seconds are a LABEL for a take count, so relabelling the picker re-maps
 * every historical row through this function. Relabelling to correct the
 * head-trim overstatement moved 38s from seven takes to eight — harmless only
 * because no row held 38 and because the callers below read the real
 * `segments` array first. Recording the count removes the coincidence.
 */
function segmentsNeeded(row: VideoRow): number {
  if (typeof row.target_takes === "number" && row.target_takes > 0) {
    return row.target_takes;
  }
  return segmentsForDuration(row.target_duration_sec ?? 0);
}

// ---------------------------------------------------------------------------
// v2: planning and keyframing
// ---------------------------------------------------------------------------

/**
 * Claim one of the queued steps. Same conditional-UPDATE pattern as the
 * assembly and narration claims — unclaimed, or claimed by a run that has since
 * died.
 */
async function claimStep(
  supabase: SupabaseClient,
  rowId: string,
  statusColumn: "plan_status" | "keyframe_status",
  claimColumn: "plan_claimed_at" | "keyframe_claimed_at",
  ttlMs: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const { data, error } = await supabase
    .from("videos")
    .update({ [statusColumn]: "running", [claimColumn]: new Date().toISOString() })
    .eq("id", rowId)
    .or(
      `${statusColumn}.is.null,and(${statusColumn}.eq.running,${claimColumn}.lt.${cutoff})`,
    )
    .select("id");
  if (error) {
    console.error(`[video/advance] ${statusColumn} claim failed:`, error.message);
    return false;
  }
  return !!data?.length;
}

/**
 * Submit an original-pipeline clip to the provider.
 *
 * This is the second half of what the old POST handler did inline: distil the
 * intent into a frame the keyframe model can draw, then create the job. It is a
 * model call and a provider call — five to twenty seconds — which is exactly the
 * kind of work that has no business happening while a user waits with the
 * Generate button disabled.
 *
 * It reuses the KEYFRAME claim columns rather than inventing its own: this IS
 * v1's keyframe-and-submit step, and a v1 row never reaches `keyframeStep`.
 *
 * A provider rejection is terminal and refunded here, because there is no
 * request left to refund from — the one that charged returned 202 long ago.
 */
async function submitStep(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
  kind: VideoKind;
}): Promise<VideoJob> {
  const { supabase, row, job, id, kind } = input;
  const pending: VideoJob = { ...job, status: "processing" };

  const claimed = await claimStep(
    supabase,
    row.id,
    "keyframe_status",
    "keyframe_claimed_at",
    KEYFRAME_CLAIM_TTL_MS,
  );
  if (!claimed) return pending; // another worker owns this step

  const startedAt = Date.now();
  const inputs = planInputs(row.plan);
  const profile = await brandFor(row);

  try {
    // Two prompts, on purpose, and the reason they differ has not changed:
    // `row.prompt` is the intent the narration is written from, while
    // `visualPrompt` is the one frame the keyframe model can draw and carries
    // ~230 characters of rendering directives that are noise to a writer.
    const visualPrompt = (await visualBrief(row.prompt ?? "")) + brandVideoHint(profile);

    const created = await videoProvider.create({
      kind,
      prompt: row.prompt ?? "",
      visualPrompt,
      assetUrl: inputs.assetUrl ?? undefined,
      aspectRatio: isAspectRatio(row.aspect_ratio) ? row.aspect_ratio : undefined,
      durationSec: row.target_duration_sec ?? undefined,
    });

    const { error } = await supabase
      .from("videos")
      .update({
        // `job_id` stays the client-facing id for the whole clip; this is what
        // the poll actually asks the provider about.
        provider_request_id: created.id,
        provider_prompt: created.providerPrompt ?? null,
        segments: created.takes ?? [],
        thumbnail_url: created.thumbnailUrl ?? row.thumbnail_url,
        keyframe_status: "done",
        keyframe_claimed_at: null,
        status: "processing",
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    await recordMetrics(supabase, row.id, { submitMs: Date.now() - startedAt });
    console.log(`[video/advance] submitted ${id} to the provider as ${created.id}`);
    return { ...pending, progress: { done: 0, total: (created.takes ?? []).length || 1 } };
  } catch (err) {
    console.error(`[video/advance] submit failed for ${id}:`, err);
    const message =
      "The video provider rejected this generation — your credits were refunded.";
    const { data: firstToFail } = await supabase
      .from("videos")
      .update({
        status: "failed",
        keyframe_status: "done",
        keyframe_claimed_at: null,
        plan: { ...(typeof row.plan === "object" && row.plan ? row.plan : {}), error: message },
      })
      .eq("id", row.id)
      .neq("status", "failed")
      .select("id");
    if (firstToFail?.length) {
      const total = segmentsNeeded(row) || 1;
      await refundTakes({ row, takesLost: total, takesTotal: total, reason: "video_provider_failed" });
    }
    return { ...job, status: "failed", error: message };
  }
}

/** How long a planning / keyframing claim is honoured before it can be retaken. */
const PLAN_CLAIM_TTL_MS = 10 * 60 * 1000;
const KEYFRAME_CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * Write the script and the shot list. Three model calls, no provider spend.
 *
 * A planning failure is NOT terminal for the clip: `buildPlan` never throws and
 * degrades to a one-visual plan that reproduces the pre-plan behaviour, so the
 * worst case is the video that would have been made anyway.
 */
async function planStep(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
}): Promise<VideoJob> {
  const { supabase, row, job } = input;
  const pending: VideoJob = { ...job, status: "processing" };

  const claimed = await claimStep(
    supabase,
    row.id,
    "plan_status",
    "plan_claimed_at",
    PLAN_CLAIM_TTL_MS,
  );
  if (!claimed) return pending; // another worker owns this step

  const startedAt = Date.now();
  try {
    const inputs = planInputs(row.plan);
    // Planning is the first stage to touch the brand, so it is where the
    // snapshot is taken if the queueing request did not already take one.
    const profile = await brandFor(row);
    const takes = segmentsNeeded(row);

    const plan = await buildPlan({
      prompt: row.prompt ?? "",
      kind: (row.kind ?? "ugc") as VideoKind,
      shotCount: takes,
      seconds: row.target_duration_sec ?? assembledSeconds(takes),
      profile,
      tone: row.tone && CONTENT_TONES.includes(row.tone) ? row.tone : null,
      hasProductAsset: !!inputs.assetUrl,
      canRecordScreen: !!inputs.productUrl,
    });

    const { error } = await supabase
      .from("videos")
      .update({
        // The seeded inputs are preserved: the keyframe step still needs them,
        // and it runs after this write.
        plan: { inputs, ...plan },
        plan_status: "done",
        plan_claimed_at: null,
        // Freeze the brand now if nothing has yet, so every later stage — and
        // any re-run of this one — sees the same identity.
        ...(row.brand_snapshot ? {} : { brand_snapshot: profile }),
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    await recordMetrics(supabase, row.id, {
      planMs: Date.now() - startedAt,
      scriptsConsidered: plan.considered,
      shotKinds: plan.shots.map((s) => s.kind),
    });

    console.log(
      `[video/advance] planned ${input.id}: ${plan.considered} scripts, ` +
        `${plan.shots.length} shots — ${plan.critique.slice(0, 120)}`,
    );
    return pending;
  } catch (err) {
    console.error("[video/advance] planning failed:", err);
    // Release the claim so a later poll retries. If it never succeeds the age
    // write-off eventually fails and refunds the row.
    await supabase
      .from("videos")
      .update({ plan_status: null, plan_claimed_at: null })
      .eq("id", row.id);
    return pending;
  }
}

/**
 * Draw a frame for every shot, check them, and submit the takes.
 *
 * This is the step that starts spending provider credits, which is why the
 * keyframe validation sits INSIDE it rather than after: a frame with a
 * six-fingered hand is free to discard here and costs 9 credits and up to nine
 * minutes to discover after the take has rendered.
 */
async function keyframeStep(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
  kind: VideoKind;
}): Promise<VideoJob> {
  const { supabase, row, job, id, kind } = input;
  const pending: VideoJob = { ...job, status: "processing" };

  const claimed = await claimStep(
    supabase,
    row.id,
    "keyframe_status",
    "keyframe_claimed_at",
    KEYFRAME_CLAIM_TTL_MS,
  );
  if (!claimed) return pending;

  const startedAt = Date.now();
  try {
    const plan = storedPlan(row.plan);
    if (!plan) throw new Error("keyframe step reached with no stored plan");
    const inputs = planInputs(row.plan);
    const workspaceId = row.workspace_id!;
    const profile = await brandFor(row);
    const ratio = isAspectRatio(row.aspect_ratio) ? row.aspect_ratio : "9:16";
    const durationSec = row.target_duration_sec ?? assembledSeconds(plan.shots.length);

    const frames = await buildKeyframes({
      plan,
      kind,
      ratio,
      profile,
      workspaceId,
      jobId: id,
      productAssetUrl: inputs.assetUrl,
      // Checked and redrawn BEFORE anything is derived from it — see
      // buildKeyframes. Shot 0 animates the master directly and every other
      // shot is derived from it, so this is the one frame with no fallback.
      validateMaster: (url) =>
        validateKeyframe({ frameUrl: url, shot: plan.shots[0], masterUrl: null }),
      // Deliberately NOT passed as the master frame.
      //
      // In the original pipeline an attached image WAS the keyframe — "animate
      // my product shot" — because there was only one keyframe and no plan. A
      // storyboard changes what an uploaded asset means: it is the reference
      // for the shots that show the PRODUCT, while the master frame's job is to
      // establish the person and the place. Using a product photo as the master
      // makes every shot a derivative of that photo and throws the storyboard
      // away.
    });

    // Look at every frame before animating any of them. Frames that fail are
    // NOT regenerated here — a failed derivation falls back to the master,
    // which is a known-good frame, and that is both cheaper and more reliable
    // than asking the same model for a second opinion on its own output.
    const checks = await Promise.all(
      plan.shots
        .filter((s) => s.kind === "generated" || s.kind === "product_asset")
        .map(async (shot) => {
          const frameUrl = frames.byShot[shot.index];
          const verdict = await validateKeyframe({
            frameUrl,
            masterUrl: frames.masterUrl,
            shot,
            expectProduct: shot.kind === "product_asset",
          });
          return { shot, frameUrl, verdict };
        }),
    );

    let rejected = 0;
    let rejectedMaster = 0;
    for (const c of checks) {
      if (!c.verdict.checked || c.verdict.ok) continue;
      rejected += 1;
      const problems = c.verdict.problems.join("; ");
      // Falling back only means something for a DERIVED frame. Shot 0 animates
      // the master itself, so "use the master instead" would be a no-op dressed
      // up as a fix — and the first real run hit exactly that case, logging a
      // recovery that had not happened. Say which one it was.
      if (c.frameUrl === frames.masterUrl) {
        rejectedMaster += 1;
        // Record WHAT was wrong, not just that something was.
        //
        // This verdict is the freshest and most specific evidence about the
        // frame every take is animated from, and it was being thrown away —
        // only the count survived, into `metrics.keyframesRejectedMaster`. The
        // text is what `inheritedFromKeyframe` needs: that guard exists to stop
        // a shot being re-rendered for a defect baked into its keyframe, and it
        // matches on shared words against exactly this list. Measured: the
        // check said "Legible branding on the cap" here, the rendered shot came
        // back "Legible branding on the hat in all frames", and because the
        // former never reached the list the guard saw one shared word where it
        // needs two — so it re-rendered the same frame for 9 credits and got
        // the same complaint. Merged, those two share {legible, branding} and
        // the re-render is correctly skipped.
        for (const p of c.verdict.problems) {
          if (!frames.masterProblems.includes(p)) frames.masterProblems.push(p);
        }
        console.error(
          `[video/advance] MASTER frame rejected (${problems}) — no better frame to fall back to; shot ${c.shot.index} renders as-is`,
        );
      } else {
        console.log(
          `[video/advance] keyframe ${c.shot.index} rejected (${problems}) — using the master frame`,
        );
        frames.byShot[c.shot.index] = frames.masterUrl;
      }
    }

    // Screen recordings: real footage of the real product, produced locally.
    // These consume no provider credit, so every one of them is a take we do
    // not have to buy — and the difference is refunded below.
    const takes: Take[] = [];
    let submitted = 0;
    for (const shot of plan.shots) {
      if (shot.kind === "playwright_capture" && inputs.productUrl) {
        const captured = await captureShotClip({
          url: inputs.productUrl,
          aspectRatio: ratio,
          workspaceId,
          jobId: id,
          index: shot.index,
        }).catch((err) => {
          console.error(`[video/advance] shot ${shot.index} capture failed:`, err);
          return null;
        });
        if (captured) {
          takes.push({
            index: shot.index,
            requestId: `local:capture:${shot.index}`,
            url: captured.url,
            seconds: captured.durationSec,
            kind: shot.kind,
            visual: shot.visual,
            direction: shot.direction,
            attempts: 1,
          });
          continue;
        }
        // Capture failed — fall through and render it like any other shot.
      }

      const requestId = await submitTake({
        prompt: promptForShot(shot, kind),
        imageUrl: frames.byShot[shot.index],
        durationSec,
      });
      submitted += 1;
      takes.push({
        index: shot.index,
        requestId,
        kind: shot.kind === "playwright_capture" ? "generated" : shot.kind,
        keyframeUrl: frames.byShot[shot.index],
        visual: shot.visual,
        direction: shot.direction,
        attempts: 1,
      });
    }

    takes.sort((a, b) => a.index - b.index);
    const providerTake = takes.find((t) => !isLocalTake(t));

    const { error } = await supabase
      .from("videos")
      .update({
        segments: takes,
        // The client-facing id stays `job_id`; this is what the poll actually
        // asks the provider about. Null when every shot was captured locally.
        provider_request_id: providerTake?.requestId ?? null,
        thumbnail_url: row.thumbnail_url ?? frames.masterUrl,
        provider_prompt:
          `[style] ${plan.styleAnchor}\n\n` +
          takes.map((t) => `[${t.index}] ${t.visual ?? ""} ${t.direction ?? ""}`).join("\n"),
        keyframe_status: "done",
        keyframe_claimed_at: null,
        status: "processing",
        // Carried on the plan so the assembly pass can tell an inherited
        // defect from one the animation introduced.
        plan: { inputs, ...plan, masterProblems: frames.masterProblems },
      })
      .eq("id", row.id);
    if (error) throw new Error(error.message);

    // Give back the takes we did not buy. A shot recorded with Playwright is a
    // shot the user paid a provider render for and did not get one of — they
    // got something better, but the credit difference is still theirs.
    const captured = takes.length - submitted;
    if (captured > 0) {
      await refundTakes({
        row,
        takesLost: captured,
        takesTotal: takes.length,
        reason: "video_shot_captured",
      });
    }

    await recordMetrics(supabase, row.id, {
      keyframeMs: Date.now() - startedAt,
      keyframesDerived: frames.derived,
      keyframesReusedMaster: frames.reused,
      keyframesRejected: rejected,
      keyframesRejectedMaster: rejectedMaster,
      masterAttempts: frames.masterAttempts,
      masterProblemsRemaining: frames.masterProblems,
      takesSubmitted: submitted,
      shotsCaptured: captured,
      providerCreditsSubmitted: submitted * PROVIDER_CREDITS_PER_TAKE,
    });

    console.log(
      `[video/advance] keyframed ${id}: ${frames.derived} derived, ` +
        `${frames.reused} reused, ${rejected} rejected, ${submitted} takes submitted`,
    );
    return { ...pending, progress: { done: 0, total: takes.length } };
  } catch (err) {
    console.error("[video/advance] keyframe step failed:", err);
    await supabase
      .from("videos")
      .update({ keyframe_status: null, keyframe_claimed_at: null })
      .eq("id", row.id);
    return pending;
  }
}

/**
 * Did this shot's defect come from the frame it animated?
 *
 * Compared against the master's own unresolved problems, recorded at keyframe
 * time. If the still already had it, animating the still again will have it
 * too, and the re-render is 9 provider credits spent on a certainty.
 *
 * Matched loosely on the distinctive words rather than exactly: two vision
 * calls describing the same watermark phrase it differently ("Readable logo in
 * the bottom right corner", "Readable text or logo drawn into the picture").
 */
function inheritedFromKeyframe(verdict: Verdict | undefined, plan: unknown): boolean {
  if (!verdict?.checked || verdict.ok) return false;
  const known = masterProblemsOf(plan);
  if (known.length === 0) return false;
  // Trailing "s" stripped so a plural matches its singular. The vision model
  // does not phrase the same defect the same way twice, and the difference is
  // routinely just number: measured in one run, shot 4 said "wrong finger
  // count" and matched the keyframe's "incorrect finger count" on three words,
  // while shot 0 said "extra fingers" and matched the same keyframe on one —
  // so an identical inherited defect was skipped on one shot and re-rendered
  // for 9 credits on the other, decided entirely by a letter.
  const words = (t: string) =>
    new Set((t.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.replace(/s$/, "")));
  return verdict.problems.some((p) => {
    const a = words(p);
    return known.some((k) => {
      const b = words(k);
      let shared = 0;
      for (const w of a) if (b.has(w)) shared += 1;
      // Two or more distinctive words in common is the same complaint.
      return shared >= 2;
    });
  });
}

/** Defects the master frame still had when we settled for it. */
function masterProblemsOf(plan: unknown): string[] {
  if (!plan || typeof plan !== "object") return [];
  const v = (plan as { masterProblems?: unknown }).masterProblems;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The prompt for one shot's take.
 *
 * Note what is NOT here: the canned per-type camera direction the old pipeline
 * appended. That list existed because nothing knew what any given take was
 * supposed to be about, so every take got generic coverage off a rotating list.
 * A planned shot carries its own direction, written against the line it covers
 * — so the list is only a fallback for a shot the storyboard left blank.
 */
function promptForShot(shot: Shot, kind: VideoKind): string {
  const spec = specForKind(kind);
  const direction = shot.direction || promptForTake("", kind, shot.index);
  return [shot.visual, spec.motion, direction].filter(Boolean).join(" ").trim();
}

// ---------------------------------------------------------------------------
// Multi-take assembly
// ---------------------------------------------------------------------------

/**
 * Drive a multi-take clip: sync every take that has finished, and join them
 * once the set is complete.
 *
 * All takes were submitted together at generation time and render concurrently
 * at the provider, so this never has to submit anything — it collects. The work
 * is claimed with a conditional UPDATE, which Postgres serializes at the row
 * level: concurrent polls re-evaluate the predicate once the lock releases,
 * match zero rows, and report the job as still processing. Without that, a
 * dozen overlapping polls would each download the same takes and each run their
 * own ffmpeg pass over the same clip.
 */
async function assembleTakes(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
  kind: VideoKind;
}): Promise<VideoJob> {
  const { supabase, row, job, id, kind } = input;
  const known = parseTakes(row.segments);
  const total = known.length || segmentsNeeded(row);

  // Already assembled — serve the finished cut (narrating it if that is still
  // outstanding, e.g. a poll died between the join and the narration).
  if (row.assembly_status === "done" && row.url) {
    return finished({ supabase, row, job, id, kind, url: row.voiced_url ?? row.url });
  }

  const progress = (takes: Take[]) => ({
    done: takes.filter((t) => t.url || t.failed).length,
    total,
  });
  /**
   * An in-progress answer, with NO url on it.
   *
   * `job` here is the provider's state for TAKE 0 — that is the request id the
   * poll follows — so the moment take 0 finishes it carries take 0's own
   * ~5.4-second clip in `url`. Spreading it into a "processing" response
   * published that raw take as if it were the video: the page merges any url it
   * is given, so a 35-second clip showed a five-second one in the player for
   * the entire remaining render, and anyone who opened or downloaded it then
   * got five seconds. It corrected itself only once assembly finished, which is
   * minutes later and long after the user has looked.
   *
   * A clip that is still rendering has no deliverable url, so it must not
   * report one. The thumbnail is kept: a poster frame from take 0 is a
   * legitimate preview of what is coming.
   */
  const inProgress = (takes: Take[]): VideoJob => ({
    ...job,
    status: "processing",
    url: undefined,
    progress: progress(takes),
  });

  const rendering: VideoJob = inProgress(known);

  const claimed = await claimAssembly(supabase, row.id);
  if (!claimed) return rendering; // another poll owns this step

  try {
    // Re-read inside the claim: the row may have moved on while we waited.
    const { data: fresh } = await supabase
      .from("videos")
      .select(ROW_COLUMNS)
      .eq("id", row.id)
      .maybeSingle<VideoRow>();
    const current = fresh ?? row;
    const workspaceId = current.workspace_id ?? row.workspace_id!;
    let takes = parseTakes(current.segments);
    if (takes.length === 0) {
      // Row predates multi-take assembly, or the take list never persisted.
      // Nothing to collect — fall back to the single-take path.
      await releaseAssembly(supabase, row.id);
      return job;
    }

    // Collect every take that has finished since the last poll. Each provider
    // request is independent, so one slow or broken take never blocks the rest.
    let changed = false;
    let rerendered = 0;
    for (const take of pendingTakes(takes)) {
      // A locally produced shot — a screen recording — has no provider request
      // behind it. Asking the provider about `local:capture:2` would 404 and be
      // logged as a poll failure forever.
      if (isLocalTake(take)) continue;

      let state: VideoJob;
      try {
        state = await videoProvider.status(take.requestId, kind);
      } catch (err) {
        console.error(`[video/advance] take ${take.index} poll failed:`, err);
        continue;
      }
      if (state.status === "failed") {
        take.failed = true;
        changed = true;
        console.error(`[video/advance] take ${take.index} failed at the provider`);
        continue;
      }
      if (state.status !== "completed" || !state.url) continue;

      // Look at what came back, while it is on disk (see storeTake's `inspect`).
      // Only v2 takes carry the shot description this needs.
      let verdict: Verdict | undefined;
      const stored = await storeTake({
        sourceUrl: state.url,
        workspaceId,
        jobId: id,
        index: take.index,
        inspect:
          current.pipeline === "v2" && take.visual
            ? async (localPath) => {
                verdict = await validateRenderedShot({
                  videoPath: localPath,
                  shot: {
                    index: take.index,
                    kind: (take.kind ?? "generated") as Shot["kind"],
                    line: "",
                    visual: take.visual ?? "",
                    direction: take.direction ?? "",
                  },
                });
              }
            : undefined,
      });

      // A shot that failed the check gets ONE more render, from the same
      // keyframe. Only this shot — the others are independent provider requests
      // that have already rendered fine, and re-rolling the whole clip to fix
      // one bad five seconds is what makes regeneration unaffordable.
      const attempts = take.attempts ?? 1;
      // A defect the KEYFRAME already had cannot be fixed by animating that
      // same keyframe again. Measured: a master carrying a model-drawn
      // watermark was rejected, both shots were re-rendered from it, and both
      // came back with the identical complaint — 18 provider credits spent to
      // reproduce a known-bad frame. Re-render only for defects that could
      // plausibly have come from the ANIMATION.
      const inherited = inheritedFromKeyframe(verdict, current.plan);
      if (inherited && verdict) {
        console.log(
          `[video/advance] shot ${take.index} defect was already in its keyframe ` +
            `(${verdict.problems.join("; ")}) — not re-rendering`,
        );
      }
      if (
        verdict?.checked &&
        !verdict.ok &&
        !inherited &&
        attempts < MAX_SHOT_ATTEMPTS &&
        take.keyframeUrl
      ) {
        try {
          const retryId = await submitTake({
            prompt: [take.visual, take.direction].filter(Boolean).join(" "),
            imageUrl: take.keyframeUrl,
            durationSec: current.target_duration_sec ?? assembledSeconds(takes.length),
          });
          console.log(
            `[video/advance] shot ${take.index} rejected (${verdict.problems.join("; ")}) — re-rendering`,
          );
          take.requestId = retryId;
          take.attempts = attempts + 1;
          take.validation = { ok: false, problems: verdict.problems };
          // Deliberately left with no url so it reads as pending again.
          changed = true;
          rerendered += 1;
          continue;
        } catch (err) {
          // Could not resubmit — keep the flawed take rather than losing the
          // shot entirely. A clip with one weak shot beats a clip with a hole.
          console.error(`[video/advance] shot ${take.index} re-render failed:`, err);
        }
      }

      take.url = stored.url;
      take.seconds = stored.seconds;
      if (verdict?.checked) {
        take.validation = { ok: verdict.ok, problems: verdict.problems };
      }
      changed = true;
    }

    if (rerendered > 0) {
      await recordMetrics(
        supabase,
        row.id,
        {
          shotRerenders: rerendered,
          providerCreditsRerenders: rerendered * PROVIDER_CREDITS_PER_TAKE,
        },
        ["shotRerenders", "providerCreditsRerenders"],
      );
    }

    if (changed) {
      takes = [...takes];
      await supabase.from("videos").update({ segments: takes }).eq("id", row.id);
    }

    const usable = renderedTakes(takes);
    const stillRendering = pendingTakes(takes);

    if (stillRendering.length > 0) {
      await releaseAssembly(supabase, row.id);
      return inProgress(takes);
    }

    // Every take has come back. If none rendered, the generation failed.
    if (usable.length === 0) {
      await supabase
        .from("videos")
        .update({ status: "failed", assembly_status: "done", assembly_claimed_at: null })
        .eq("id", row.id);
      // Safe to refund unconditionally: this runs inside the assembly claim,
      // and the row is left assembly_status='done', which the early return at
      // the top of this function takes on every later poll.
      await refundTakes({
        row: current,
        takesLost: takes.length,
        takesTotal: takes.length,
        reason: "video_all_takes_failed",
      });
      return { ...job, status: "failed", url: undefined, progress: progress(takes) };
    }

    // Join what we have. A clip short a failed take is still a deliverable
    // clip — better than discarding five paid renders over one bad one. It is
    // also SHORTER than the one that was paid for, so the difference goes back.
    const lost = takes.length - usable.length;
    if (lost > 0) {
      await refundTakes({
        row: current,
        takesLost: lost,
        takesTotal: takes.length,
        reason: "video_takes_failed",
      });
    }

    const full = await concatTakes({
      takes,
      workspaceId,
      jobId: id,
      aspectRatio: isAspectRatio(current.aspect_ratio) ? current.aspect_ratio : undefined,
    });

    await supabase
      .from("videos")
      .update({
        url: full.url,
        status: "completed",
        assembly_status: "done",
        assembly_claimed_at: null,
      })
      .eq("id", row.id);

    const assembled: VideoJob = {
      ...job,
      status: "completed",
      url: full.url,
      durationSec: Math.round(full.durationSec),
      progress: progress(takes),
    };
    return await narrate({ supabase, row: { ...current, url: full.url }, job: assembled, id, kind });
  } catch (err) {
    console.error("[video/advance] assembly step failed:", err);
    await releaseAssembly(supabase, row.id);
    // Transient by assumption — the next poll retries this same step.
    return rendering;
  }
}

/** Serve an already-assembled clip, narrating it if that hasn't happened yet. */
async function finished(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
  kind: VideoKind;
  url: string;
}): Promise<VideoJob> {
  const { supabase, row, job, id, kind, url } = input;
  const done: VideoJob = {
    ...job,
    status: "completed",
    url,
    durationSec: row.voiced_duration_sec ?? job.durationSec,
  };
  return narrate({ supabase, row, job: done, id, kind });
}

async function claimAssembly(supabase: SupabaseClient, rowId: string): Promise<boolean> {
  const cutoff = new Date(Date.now() - ASSEMBLY_CLAIM_TTL_MS).toISOString();
  const { data, error } = await supabase
    .from("videos")
    .update({ assembly_status: "running", assembly_claimed_at: new Date().toISOString() })
    .eq("id", rowId)
    // Unclaimed, or claimed by a run that has since died.
    .or(`assembly_status.is.null,and(assembly_status.eq.running,assembly_claimed_at.lt.${cutoff})`)
    .select("id");
  if (error) {
    console.error("[video/advance] assembly claim failed:", error.message);
    return false;
  }
  return !!data?.length;
}

async function releaseAssembly(supabase: SupabaseClient, rowId: string): Promise<void> {
  const { error } = await supabase
    .from("videos")
    .update({ assembly_status: null, assembly_claimed_at: null })
    .eq("id", rowId);
  if (error) console.error("[video/advance] assembly release failed:", error.message);
}

// ---------------------------------------------------------------------------
// Single-take path (unchanged behavior) + narration
// ---------------------------------------------------------------------------

/**
 * Persist the provider's terminal state without discarding our own copies.
 *
 * The provider's `url`/`thumbnailUrl` point at a CDN that expires. Once
 * archiving or narration has put the file in our bucket, that stored URL is the
 * durable one — overwriting it on a later poll (and this route is polled every
 * 5s) trades a permanent URL for one that will 404, and if the re-archive then
 * fails there is nothing left to recover it from.
 */
async function mirror(input: {
  supabase: SupabaseClient;
  row: VideoRow | null;
  job: VideoJob;
  id: string;
}): Promise<VideoJob> {
  const { supabase, row, job, id } = input;

  const durableUrl = row?.voiced_url ?? (isOurs(row?.url) ? row?.url : null) ?? null;
  const durableThumb = isOurs(row?.thumbnail_url) ? row?.thumbnail_url ?? null : null;

  const { error } = await supabase
    .from("videos")
    .update({
      status: job.status,
      ...(durableUrl ? {} : { url: job.url ?? null }),
      ...(durableThumb ? {} : { thumbnail_url: job.thumbnailUrl ?? null }),
    })
    .eq("job_id", id);
  if (error) {
    console.error("[video/advance] mirror update failed:", error.message);
  }

  return durableUrl ? { ...job, url: durableUrl } : job;
}

/**
 * Add narration to a completed clip, exactly once.
 *
 * Narration costs real money — one GPT call plus one TTS render per clip — and
 * the client polls this route on a fixed 5s interval without awaiting the
 * previous request, so a poll that blocks for minutes inside the pipeline
 * accumulates a dozen or more overlapping requests behind it. A plain
 * read-then-write check on `voiced_url` lets every one of them pass, each
 * paying for its own pipeline and racing the others' upsert to the same storage
 * key (leaving the stored script describing a different render than the file).
 *
 * So the work is claimed with a conditional UPDATE, which Postgres serializes
 * at the row level: the losers re-evaluate the predicate once the lock releases
 * and match zero rows. They report the job as still processing so the client
 * keeps polling and ends up receiving the voiced cut rather than the silent one.
 */
async function narrate(input: {
  supabase: SupabaseClient;
  row: VideoRow | null;
  job: VideoJob;
  id: string;
  kind: VideoKind;
}): Promise<VideoJob> {
  const { supabase, row, job, kind } = input;
  if (!job.url || !row?.workspace_id) return job;

  // Already narrated — serve the stored voiced cut.
  if (row.voiced_url) {
    return {
      ...job,
      url: row.voiced_url,
      durationSec: row.voiced_duration_sec ?? job.durationSec,
    };
  }

  // Narration was ruled out for a reason that cannot change on a retry (no
  // OpenAI key, no ffmpeg, source already had audio). Serve the silent clip.
  if (row.voiceover_status === "skipped") return job;

  const now = Date.now();
  const cutoff = new Date(now - CLAIM_TTL_MS).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("videos")
    .update({
      voiceover_status: "running",
      voiceover_claimed_at: new Date(now).toISOString(),
    })
    .eq("id", row.id)
    // Unclaimed, or claimed by a run that has since died.
    .or(`voiceover_status.is.null,and(voiceover_status.eq.running,voiceover_claimed_at.lt.${cutoff})`)
    .select("id");

  if (claimError) {
    console.error("[video/advance] narration claim failed:", claimError.message);
    return job;
  }
  if (!claimed?.length) {
    // Another request owns the narration. Report the job as still in flight so
    // the client polls again instead of settling on the silent clip.
    return { ...job, status: "processing" };
  }

  // Ground the script in the brand that owns THIS video, not in whatever
  // workspace the polling session happens to own.
  const profile = await brandFor(row);
  const plan = storedPlan(row.plan);

  const outcome = await addVoiceover({
    videoUrl: job.url,
    // The grounded concept when a step wrote one — a demo of somebody else's
    // site records THEIR product, so its narration is written against the brand
    // that was captured rather than against the workspace's own words. Every
    // other row falls through to the prompt as typed, which is also what the
    // history list shows back to the user.
    prompt: narrationPromptOf(row.plan) ?? row.prompt ?? "",
    kind,
    workspaceId: row.workspace_id,
    jobId: input.id,
    profile,
    // Guarded rather than trusted: this is free text out of the database, and
    // a stale or hand-edited value must fall back to "let the model choose"
    // instead of indexing TONE_LABEL with something that isn't a tone.
    tone: row.tone && CONTENT_TONES.includes(row.tone) ? row.tone : null,
    // The length this clip was sold as. Post-production cuts to exactly this
    // so the picker's label and the delivered file agree — and only ever
    // downward, so a clip salvaged from a partial set stays its real length.
    targetDurationSec: row.target_duration_sec,
    // The planned script and CTA, when this row was planned. Post-production
    // speaks THESE rather than writing its own — the storyboard was cut for
    // them, so anything else desynchronises the words from the pictures.
    plannedScript: plan?.script || null,
    plannedCta: plan?.cta || null,
  });

  if (outcome.status !== "ok") {
    // Terminal causes are recorded so later polls stop paying to retry them;
    // transient ones release the claim so a retry is still possible.
    const { error } = await supabase
      .from("videos")
      .update({
        voiceover_status: outcome.status === "skipped" ? "skipped" : null,
        voiceover_claimed_at: null,
      })
      .eq("id", row.id);
    if (error) {
      console.error("[video/advance] narration claim release failed:", error.message);
    }
    return job;
  }

  // `url` is updated too, not just `voiced_url`: it is the column history and
  // every other reader use, so without it a page reload serves the silent cut
  // and the narrated file we just paid for is orphaned in storage.
  //
  // `duration_sec` is deliberately NOT touched — it records the length the user
  // requested and was charged for. The measured length goes in its own column.
  const { error: saveError } = await supabase
    .from("videos")
    .update({
      url: outcome.url,
      voiced_url: outcome.url,
      voiceover_script: outcome.script,
      voiced_duration_sec: Math.round(outcome.durationSec),
      voiceover_status: "done",
    })
    .eq("id", row.id);
  if (saveError) {
    // The file exists and is served below, but the row still points at the
    // silent cut — loud, because a reload will quietly lose the narration.
    console.error("[video/advance] narration save failed:", saveError.message);
  }

  // What the finished file actually measured, and which branding steps landed.
  // Recorded for every pipeline, not just v2: the comparison is the point.
  if (outcome.checks) {
    await recordMetrics(supabase, row.id, {
      finalChecksOk: outcome.checks.ok,
      finalCheckProblems: outcome.checks.problems,
      branding: outcome.checks.branding,
      fontFallback: outcome.checks.fontFallback,
      finishedAt: new Date().toISOString(),
    });
  }

  return { ...job, url: outcome.url, durationSec: outcome.durationSec };
}
