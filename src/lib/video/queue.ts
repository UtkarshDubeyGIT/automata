import { randomUUID } from "node:crypto";
import { grantCredits, spendCredits, CREDIT_COST } from "@/lib/credits";
import type { BrandProfile } from "@/lib/brand";
import type { ContentTone } from "@/lib/ai/content";
import {
  segmentsForDuration,
  specForKind,
  videoCreditCost,
  type AspectRatio,
  type VideoJob,
  type VideoKind,
} from "./higgsfield";

/**
 * Queue a video generation — the one place a `videos` row is born.
 *
 * `POST /api/video/generate` owned every line of this: the price, the charge,
 * the row shape, the brand snapshot, the runner kickoff. That was fine while a
 * browser was the only thing that could ask for a clip. An automation is the
 * second caller, and it cannot go through the route at all — the route reads
 * the brand profile from the request's cookies, and a run driven by the beat
 * has no cookies, no session and no user.
 *
 * Copying the twenty lines into `steps.ts` would have meant two prices, two
 * row shapes and two answers to "was the brand frozen?", diverging on the
 * first change to either. So the route keeps what is genuinely HTTP — parsing,
 * refusing, phrasing the refusal — and everything downstream of "this request
 * is valid" lives here, called with an explicit workspace, profile and db
 * client instead of reaching for the ambient ones.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from(table: string): any };

const COST_BY_KIND: Record<VideoKind, number> = {
  ugc: CREDIT_COST.video_ugc,
  shortform: CREDIT_COST.video_shortform,
  cinematic: CREDIT_COST.video_cinematic,
  avatar: CREDIT_COST.video_avatar,
  demo: CREDIT_COST.video_demo,
};

const REASON_BY_KIND: Record<
  VideoKind,
  "video_ugc" | "video_shortform" | "video_cinematic" | "video_avatar" | "video_demo"
> = {
  ugc: "video_ugc",
  shortform: "video_shortform",
  cinematic: "video_cinematic",
  avatar: "video_avatar",
  demo: "video_demo",
};

export interface QueueVideoInput {
  /** RLS client for a request, admin client for a run. */
  db: DbClient;
  workspaceId: string;
  /**
   * The brand as it is RIGHT NOW, frozen onto the row. Rendering reads the
   * brand at four separate stages over ten-plus minutes; snapshotting here is
   * what stops a rescan halfway through rebranding a clip that is already half
   * rendered.
   */
  profile: BrandProfile | null;
  kind: VideoKind;
  /** The intent. Stored on the row; the narration is written from it. */
  prompt: string;
  aspectRatio: AspectRatio;
  /** Already normalized to a whole number of takes by the caller. */
  durationSec: number;
  tone?: ContentTone | null;
  /** A keyframe still the caller attached, if any. */
  assetUrl?: string | null;
  /** The page a demo records, or a shot may screen-record. */
  productUrl?: string | null;
  /** One row per variation. A demo is always one. */
  count?: number;
  /**
   * Ledger idempotency key. The browser path has none — a second click is a
   * second video, deliberately. A workflow step passes its own run+step
   * identity, so a run re-driven after a timeout renders one clip, not two.
   */
  idemKey?: string;
}

export type QueueVideoResult =
  | { ok: true; jobs: VideoJob[]; cost: number }
  | { ok: false; reason: "credits"; error: string; balance: number }
  | { ok: false; reason: "insert"; error: string };

export async function queueVideos(input: QueueVideoInput): Promise<QueueVideoResult> {
  const { db, workspaceId, kind, prompt, aspectRatio, durationSec, profile } = input;
  const takes = segmentsForDuration(durationSec);

  // A demo is one capture, never variations: it records a real page, and
  // recording it twice produces the same clip twice.
  const rows = kind === "demo" ? 1 : Math.min(Math.max(input.count ?? 1, 1), 4);

  // Length is billed, not free: a 30s clip is six provider renders and a 5s
  // clip is one. Same function the Video page quotes from, so the price on the
  // button is the price charged here — and now also the price an automation
  // pays, which was the other reason to share this code rather than copy it.
  const cost = videoCreditCost({
    listedPrice: COST_BY_KIND[kind],
    kind,
    durationSec,
    count: rows,
  });
  const spend = await spendCredits(
    workspaceId,
    cost,
    REASON_BY_KIND[kind],
    undefined,
    input.idemKey,
  );
  if (!spend.ok) {
    return {
      ok: false,
      reason: "credits",
      error: `Not enough credits to render the video — it costs ${cost} and the balance is ${spend.balance}.`,
      balance: spend.balance,
    };
  }

  const createdAt = new Date().toISOString();
  // Which state machine drives this row. 'demo' is a capture, 'v2' the planned
  // pipeline — recorded rather than inferred, because a row whose planning
  // failed has no plan and must still be driven as v2.
  const pipeline = kind === "demo" ? "demo" : "v2";

  const queued: VideoJob[] = Array.from({ length: rows }, () => ({
    id: `${kind === "demo" ? "demo" : "vid"}_${randomUUID()}`,
    status: "queued" as const,
    kind,
    prompt,
    aspectRatio,
    // A demo's length is a property of the page being recorded, not of
    // anything anyone chose, so there is nothing honest to quote until it is
    // captured.
    ...(kind === "demo" ? {} : { durationSec, progress: { done: 0, total: takes } }),
    createdAt,
  }));

  const { error } = await db.from("videos").insert(
    queued.map((job) => ({
      workspace_id: workspaceId,
      kind,
      prompt,
      status: "queued",
      job_id: job.id,
      aspect_ratio: aspectRatio,
      ...(kind === "demo" ? {} : { target_duration_sec: durationSec, target_takes: takes }),
      tone: input.tone ?? null,
      pipeline,
      // Seeded, not computed: every step runs later and in another process,
      // and this is the only record of what was attached or asked for.
      plan: { inputs: { assetUrl: input.assetUrl ?? null, productUrl: input.productUrl ?? null } },
      brand_snapshot: profile,
      segments: [],
    })),
  );

  if (error) {
    // The row is the ONLY record that anything was asked for, so losing it
    // means the generation will never happen and the credits are simply gone.
    console.error("[video/queue] row insert failed:", error.message);
    await grantCredits(workspaceId, cost, "refund", "video_row_insert_failed");
    return { ok: false, reason: "insert", error: "Couldn't queue that video." };
  }

  return { ok: true, jobs: queued, cost };
}

/**
 * Start rendering now rather than waiting for the next beat. Fire-and-forget.
 *
 * The runner is loaded HERE, at the moment it is needed, rather than at the
 * top of this file. Importing it statically pulls the whole rendering chain —
 * the state machine, ffmpeg post-production, the capture browser, the script
 * models — into every module that can queue a clip, and one of those is now
 * `workflows/steps.ts`, which is imported by the run engine, the preview
 * builder and every workflow endpoint. That is the trap documented in
 * lib/workflows/AGENTS.md, and it showed up the moment it was sprung: three
 * unrelated test files started failing on a transitive import they had no
 * reason to know about.
 */
export function startRendering(jobs: VideoJob[]): void {
  const ids = jobs.map((job) => job.id);
  if (!ids.length) return;
  void import("./runner")
    .then(({ driveVideoJobs }) => driveVideoJobs(ids))
    .catch((err) => console.error("[video/queue] could not start the runner:", err));
}

/** The default clip length for a type, for callers with nothing better to say. */
export function defaultDurationFor(kind: VideoKind): number {
  return specForKind(kind).defaultDurationSec;
}
