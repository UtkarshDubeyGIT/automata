/**
 * Product demo capture, as a step in the state machine.
 *
 * This is the whole of what `handleProductDemo` used to do inside
 * POST /api/video/generate: point Playwright at the product URL, read the brand
 * off the page while it is open, and decide which brand the clip is ABOUT. It
 * ran in-request because it produces a finished file rather than a provider job
 * — which meant a demo held its POST open for up to thirteen minutes, locked the
 * generator panel for the duration, and died with the tab if the user closed it.
 * Every credit spent on it was lost with the request.
 *
 * As a step it is queued like everything else: the route debits, writes the row
 * and returns, and the capture happens here under a row-level claim, driven by
 * whichever worker gets there first (the in-process runner, a polling browser,
 * or the cron sweep). Narration is NOT done here — once this writes the file the
 * row looks like any other completed generation, so the shared `narrate()` in
 * advance.ts voices it, which is how the special-case `narrateDemo` goes away.
 *
 * Nothing runtime is imported from advance.ts on purpose: advance.ts calls this,
 * and a runtime edge back would be a cycle. `VideoRow` is a type-only import,
 * which erases at compile time.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { VideoRow } from "@/lib/video/advance";
import { captureProductDemo } from "@/lib/video/capture";
import { buildDemoSubject, demoNarrationPrompt } from "@/lib/video/demo-subject";
import { assertPublicUrl } from "@/lib/net/public-url";
import { sameSite } from "@/lib/net/host";
import { analyzeWebsite } from "@/lib/ai/analyze";
import { saveBrandKit, type BrandProfile, type WebsiteAnalysis } from "@/lib/brand";
import { grantCredits, CREDIT_COST } from "@/lib/credits";
import {
  isAspectRatio,
  specForKind,
  videoCreditCost,
  type AspectRatio,
  type VideoJob,
} from "@/lib/video/higgsfield";

/**
 * How long a capture claim is honoured before another worker may take it over.
 *
 * A capture is a browser launch, a page load, a full scroll and an upload —
 * tens of seconds normally, and `captureProductDemo` bounds its own steps. Ten
 * minutes is far past any real one; its only job is to stop a process that died
 * mid-capture from parking the row as claimed forever.
 */
const CAPTURE_CLAIM_TTL_MS = 10 * 60 * 1000;

/**
 * How many times a capture may be attempted before the demo is written off.
 *
 * Two. The common failures are permanent — the URL is dead, or the site refuses
 * a headless browser — and re-recording those costs a minute of Chromium for a
 * certainty. The retry exists for the other kind: a browser that crashed, a
 * network blip, a process restarted mid-capture. Past that the row fails and the
 * credits go back, which is what the synchronous path did on its first failure.
 */
const MAX_CAPTURE_ATTEMPTS = 2;

/**
 * How long the pre-read of the recorded site may take before the demo gives up
 * on it and narrates neutrally. Comfortably inside a capture, so it is normally
 * free; a ceiling only so a hung scrape cannot eat the step.
 */
const ANALYZE_TIMEOUT_MS = 45_000;

/**
 * Read a site for narration context, or give up quietly.
 *
 * `scrapeWithFirecrawl` passes no abort signal, so a wedged scrape would
 * otherwise sit there for the rest of the step's budget. The timer is cleared on
 * the winning path either way — losing a race does not cancel the loser, and a
 * stray 45s timer outliving the step is how a worker is kept alive doing nothing.
 */
function readSite(url: string): Promise<WebsiteAnalysis | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ANALYZE_TIMEOUT_MS);
  });
  return Promise.race([analyzeWebsite(url).catch(() => null), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** The scratch fields a demo row keeps on its `plan` document. */
interface DemoPlan {
  inputs?: { productUrl?: string | null; assetUrl?: string | null };
  /** Attempts already made, so a permanent failure stops costing minutes. */
  captureAttempts?: number;
  /** The narration concept, grounded in the brand that was actually recorded. */
  narrationPrompt?: string;
  /** Why this demo failed, in words the generator panel can show. */
  error?: string;
  /** Whether the capture rewrote the workspace's own brand kit. */
  brandKitSaved?: boolean;
}

function demoPlan(plan: unknown): DemoPlan {
  return plan && typeof plan === "object" ? ({ ...plan } as DemoPlan) : {};
}

/** True for a row this step owns: a demo that has not produced its file yet. */
export function awaitingCapture(row: VideoRow | null | undefined): boolean {
  return (
    !!row &&
    // Every other step gates on this too: without a workspace there is nobody
    // to bill, nobody to refund and no storage prefix to record into.
    !!row.workspace_id &&
    row.kind === "demo" &&
    !row.url &&
    row.status !== "completed" &&
    row.status !== "failed"
  );
}

/**
 * Record the product demo, and hand a completed row to the narration step.
 *
 * At most one step per call, like every other stage: the claim serializes
 * concurrent workers at the row level, and a worker that loses it reports the
 * job as still in flight so its caller keeps checking.
 */
export async function captureStep(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  id: string;
}): Promise<VideoJob> {
  const { supabase, row, job, id } = input;
  const pending: VideoJob = { ...job, status: "processing" };

  const cutoff = new Date(Date.now() - CAPTURE_CLAIM_TTL_MS).toISOString();
  const { data: claimed, error: claimError } = await supabase
    .from("videos")
    .update({ assembly_status: "running", assembly_claimed_at: new Date().toISOString() })
    .eq("id", row.id)
    // Unclaimed, or claimed by a run that has since died. Demos never reach
    // `assembleTakes` — they have no `segments` to join — so these two columns
    // are free, and "the step that produces the file" is exactly what they mean.
    .or(`assembly_status.is.null,and(assembly_status.eq.running,assembly_claimed_at.lt.${cutoff})`)
    .select("id");
  if (claimError) {
    console.error("[video/capture-step] claim failed:", claimError.message);
    return pending;
  }
  if (!claimed?.length) return pending; // another worker owns this capture

  const plan = demoPlan(row.plan);
  const attempt = (plan.captureAttempts ?? 0) + 1;

  // Re-validated rather than trusted, even though the route already checked it
  // when the row was written: this points a real browser at the address, and
  // the answer DNS gives now is the one that matters. The row is also the only
  // thing carrying it across the gap between the request and this step.
  const url = await assertPublicUrl(plan.inputs?.productUrl);
  if (!url) {
    return writeOff({
      supabase,
      row,
      job,
      plan,
      attempt,
      reason: "video_demo_url_unreachable",
      message:
        "That product URL isn't reachable any more — check it's public, then generate again. Your credits were refunded.",
    });
  }

  // The workspace brand as it was when this was queued (migration 0017). It is
  // the voice donor and the answer to "is this our own site?", nothing more.
  const workspace = (row.brand_snapshot ?? null) as BrandProfile | null;
  const ownSite = sameSite(url, workspace?.website);

  // Read the site we are about to record, so the narration can be about it.
  //
  // Started here and awaited much later: Playwright's capture is tens of seconds
  // (networkidle, banner dismissal, a full scroll, an upload) and this fits
  // inside that window, so the extra reading usually costs no wall-clock at all.
  //
  // Skipped for our own site — that clip is narrated from the workspace dossier
  // exactly as it always was, so a reading here would be paid for and thrown
  // away. `readSite` never rejects, which matters at the seam rather than at the
  // await: if the capture throws we return without ever awaiting this, and a
  // bare rejection would surface as an unhandled one.
  const analysisPromise = ownSite ? Promise.resolve(null) : readSite(url);

  const aspectRatio: AspectRatio = isAspectRatio(row.aspect_ratio)
    ? row.aspect_ratio
    : specForKind("demo").defaultAspect;

  try {
    const cap = await captureProductDemo({
      url,
      aspectRatio,
      workspaceId: row.workspace_id ?? "preview",
      jobId: id,
    });

    // Persist the brand identity read during capture so every future asset
    // (copy, image, video) is generated on-brand — but ONLY when what we
    // recorded is the workspace's own site. `saveBrandKit` replaces the kit
    // wholesale, so without this gate recording a competitor's page for one
    // video permanently repainted the user's logo, palette and typography and
    // mis-branded every unrelated generation afterwards.
    //
    // Two checks, because they answer different questions: `ownSite` is about
    // the URL that was asked for, `capturedFrom` catches a redirect that took
    // the browser somewhere else between the ask and the recording.
    const kitIsOurs =
      ownSite && (!cap.brandKit?.capturedFrom || sameSite(cap.brandKit.capturedFrom, workspace?.website));
    let brandKitSaved = false;
    if (cap.brandKit && kitIsOurs && row.workspace_id) {
      await saveBrandKit(row.workspace_id, cap.brandKit);
      brandKitSaved = true;
    }

    // The brand this clip is ABOUT. For our own site that is the workspace
    // dossier exactly as before, freshened with the kit just read. For anyone
    // else's it is built from the recording itself, wearing our voice — see
    // demo-subject.ts for why the workspace identity must not cross over.
    const subject: BrandProfile = ownSite
      ? { ...workspace, brandKit: cap.brandKit ?? workspace?.brandKit }
      : buildDemoSubject({
          // Post-redirect where the capture recorded one.
          url: cap.brandKit?.capturedFrom ?? url,
          analysis: await analysisPromise,
          brandKit: cap.brandKit,
          workspace,
        });

    const { error } = await supabase
      .from("videos")
      .update({
        url: cap.url,
        thumbnail_url: cap.thumbnailUrl,
        duration_sec: Math.round(cap.durationSec),
        // NOT "completed", even though the file exists.
        //
        // A demo still has to be narrated, and narration only ever runs on a
        // row that background workers can still see: the sweep selects
        // queued/processing, and the runner stops as soon as a row reads
        // completed. Marking it done here is how a demo generated with the tab
        // closed would ship silent. `jobFromRow` reports a demo that HAS its
        // file as completed, which is what hands this to the shared narration
        // step; the mirror there writes the status for real.
        status: "processing",
        assembly_status: "done",
        assembly_claimed_at: null,
        // The subject REPLACES the workspace snapshot now that it is known, so
        // the shared narration step reads it through `brandFor` and a demo of
        // someone else's product is not voiced as the user's own brand.
        brand_snapshot: subject,
        plan: {
          ...plan,
          captureAttempts: attempt,
          // Recorded, not returned: the request that asked for this demo was
          // answered minutes ago, and the panel showing the brand kit only
          // learns it is stale when it next hears about this job.
          brandKitSaved,
          // `prompt` keeps the user's own words — it is what the history list
          // shows back to them. Only narration gets the grounded version.
          narrationPrompt: ownSite
            ? row.prompt ?? ""
            : demoNarrationPrompt(row.prompt ?? "", subject),
        },
      })
      .eq("id", row.id);
    if (error) {
      // The file exists but the row does not point at it. Loud: the next pass
      // sees an unfinished demo and will record it again, at our cost.
      console.error("[video/capture-step] save failed:", error.message);
      return pending;
    }

    console.log(`[video/capture-step] captured ${id} from ${url} in ${cap.durationSec}s`);

    // Deliberately "processing": the file is recorded but not yet voiced, and
    // reporting completion here would stop the client polling and leave it
    // showing the silent cut. The next pass narrates and completes it.
    return { ...pending, thumbnailUrl: cap.thumbnailUrl, aspectRatio, durationSec: cap.durationSec };
  } catch (err) {
    console.error(`[video/capture-step] capture failed for ${id} (attempt ${attempt}):`, err);
    if (attempt < MAX_CAPTURE_ATTEMPTS) {
      // Release the claim and let the next pass try again.
      await supabase
        .from("videos")
        .update({
          assembly_status: null,
          assembly_claimed_at: null,
          plan: { ...plan, captureAttempts: attempt },
        })
        .eq("id", row.id);
      return pending;
    }
    return writeOff({
      supabase,
      row,
      job,
      plan,
      attempt,
      reason: "video_demo_capture_failed",
      message:
        "Couldn't record that URL — make sure it's public and reachable. Your credits were refunded.",
    });
  }
}

/**
 * Fail the row, refund the capture, and record why in words the panel can show.
 *
 * The refund is the part that used to live in the route's catch block. It has to
 * move with the capture: nothing else knows a demo was charged for, and an async
 * failure has no request left to report through — which is what `plan.error` is
 * for. Conditional on the row not already being failed, so two workers reaching
 * this at once pay out once.
 */
async function writeOff(input: {
  supabase: SupabaseClient;
  row: VideoRow;
  job: VideoJob;
  plan: DemoPlan;
  attempt: number;
  reason: string;
  message: string;
}): Promise<VideoJob> {
  const { supabase, row, job, plan, attempt, reason, message } = input;

  const { data: firstToFail, error } = await supabase
    .from("videos")
    .update({
      status: "failed",
      assembly_status: "done",
      assembly_claimed_at: null,
      plan: { ...plan, captureAttempts: attempt, error: message },
    })
    .eq("id", row.id)
    .neq("status", "failed")
    .select("id");
  if (error) {
    console.error("[video/capture-step] write-off failed:", error.message);
    return { ...job, status: "processing" };
  }

  if (firstToFail?.length && row.workspace_id) {
    // A demo is billed flat — one capture is one capture — so the refund is the
    // listed price, quoted from the same function that charged it.
    const amount = videoCreditCost({ listedPrice: CREDIT_COST.video_demo, kind: "demo", count: 1 });
    try {
      await grantCredits(row.workspace_id, amount, "refund", reason);
    } catch (err) {
      // A refund that fails must not turn a failed render into a failed step.
      console.error("[video/capture-step] refund failed:", err);
    }
  }

  return { ...job, status: "failed", error: message };
}
