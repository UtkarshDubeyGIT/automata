import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fetchPublicUrl } from "@/lib/net/public-fetch";
import { createAdminClient } from "@/lib/supabase/server";
import { openaiConfigured } from "@/lib/env";
import type { VideoKind } from "@/lib/video/higgsfield";
import { addCaptions, type CaptionStyle } from "@/lib/video/captions";
import { ENDCARD_SECONDS, writeEndCardImage } from "@/lib/video/endcard";
import { finalTechnicalCheck } from "@/lib/video/validate";
import {
  missingMediaTools,
  probeDuration,
  probeDimensions,
  hasAudio,
} from "@/lib/video/probe";

// Re-exported because these moved to lib/video/probe to break an import
// cycle (validation measures files; post-production needs validation), and
// stitch.ts and advance.ts have always reached for them here.
export { missingMediaTools, probeDuration, probeDimensions, hasAudio };
import type { BrandProfile } from "@/lib/brand";
import type { ContentTone } from "@/lib/ai/content";
import { canonicalTerms } from "@/lib/brand/canonical";
import { narrationWithinBudget } from "@/lib/video/narration";
import { buildPicture, fetchLogo, fetchMusic, mux, overlayLogo } from "@/lib/video/picture";
import { setupNotice } from "@/lib/setup-notice";

/**
 * The stages this file runs, in the order it runs them. Split out because a
 * 960-line module that wrote copy, drove ffmpeg and uploaded to storage had no
 * seam a reader could stop at — see each file's own header:
 *
 * - `narration.ts` — the words: script, TTS, and the rewrite loop that makes
 *   the read fit the clip.
 * - `picture.ts` — the frames: trimming to the delivered length, appending the
 *   end card, muxing the audio, compositing the logo.
 * - `captions.ts` / `endcard.ts` / `validate.ts` — already separate, unchanged.
 *
 * What stayed here is the ORDER and the failure policy, which is the part with
 * the judgement in it: which stages may fail silently (captions, logo, end
 * card), which are terminal (`skipped`) versus worth retrying (`failed`), and
 * what the finished clip is allowed to claim about itself.
 */

// Kept exported here as well: these were part of this module's surface before
// the split, and `writeScript`/`synthesize` are the two pieces a future caller
// most plausibly wants without the rest of the pipeline.
export {
  VOICEOVER_VOICE,
  writeScript,
  synthesize,
  type ScriptDraft,
} from "@/lib/video/narration";

/**
 * Post-production: give a generated clip a voice.
 *
 * The Higgsfield DoP models this account can reach are SILENT image-to-video —
 * they emit no audio stream and they ignore the `duration` field in the request
 * body (5, 10 and 99 all render the same ~5.4s clip; verified against the live
 * API). So narration cannot come from the video provider. We synthesize it
 * ourselves: GPT writes a script sized to the clip, OpenAI TTS speaks it, and
 * ffmpeg muxes the result onto the silent video.
 *
 * Everything here is best-effort — if scripting, TTS or ffmpeg fails we return
 * null and the caller keeps the original silent clip rather than losing it.
 */

/** How long the finished silent clip may take to download. The other per-step
 *  ceilings live beside the stage they bound (narration.ts, picture.ts); their
 *  sum is still the route's maxDuration budget. */
const FETCH_TIMEOUT_MS = 120_000;

/**
 * Which caption treatment each type gets, or null for no captions.
 *
 * `avatar` is the only null, and only because the type is hidden from the
 * picker until DoP can lip-sync (see VIDEO_KIND_SPECS) — there is no point
 * captioning a format nobody can select. Everything else gets words on screen:
 * muted playback is the default on every feed these formats ship to.
 */
const CAPTION_STYLE_BY_KIND: Record<VideoKind, CaptionStyle | null> = {
  ugc: "impact",
  shortform: "impact",
  cinematic: "subtle",
  demo: "subtle",
  avatar: null,
};

export interface VoiceoverResult {
  /** Public URL of the voiced video in our own storage. */
  url: string;
  /** The narration that was spoken. */
  script: string;
  /** The call to action burned into the end card, if one was drawn. */
  cta?: string;
  /** Duration of the finished file, measured with ffprobe. */
  durationSec: number;
  /**
   * What the final gate measured. Advisory: the clip ships either way, but the
   * caller records this so a systematic failure is visible in the data rather
   * than only in a user's complaint.
   */
  checks?: {
    ok: boolean;
    problems: string[];
    /** Which branding steps actually landed, as opposed to being attempted. */
    branding: { logo: boolean; endCard: boolean; captions: boolean };
    /** TRUE when the brand's own typeface could not be embedded. */
    fontFallback: boolean;
  };
}

/**
 * Why a clip ended up without narration, which decides whether the caller
 * should ever try again:
 *
 * - `ok`      — narrated; use the result.
 * - `skipped` — TERMINAL. Nothing about this clip or this deployment will
 *               change on a retry (no OpenAI key, no ffmpeg, clip already has
 *               audio). The caller should record it and stop asking, otherwise
 *               every poll re-runs a pipeline that cannot succeed.
 * - `failed`  — TRANSIENT. A network blip, a provider 5xx, an ffmpeg crash.
 *               Safe and worthwhile to retry on a later poll.
 */
export type VoiceoverOutcome =
  | ({ status: "ok" } & VoiceoverResult)
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Download a finished silent clip, narrate it, and store the voiced result.
 *
 * Never throws: every failure is reported as a `failed`/`skipped` outcome so
 * the caller can keep serving the original silent clip. The distinction matters
 * to the caller — see VoiceoverOutcome — because retrying a terminal cause
 * burns a paid GPT + TTS cycle on every subsequent poll for nothing.
 */
export async function addVoiceover(input: {
  videoUrl: string;
  prompt: string;
  kind: VideoKind;
  workspaceId: string;
  jobId: string;
  profile?: BrandProfile | null;
  /** Per-clip tone; null/undefined lets the script model choose. */
  tone?: ContentTone | null;
  /**
   * The length this clip was sold as. The delivered file is cut to exactly
   * this, so the label on the picker and the file the user downloads agree.
   * Only ever trims: when takes failed the footage is shorter and stays so.
   */
  targetDurationSec?: number | null;
  /**
   * Optional licensed music bed. Nothing supplies one today (see the decision
   * to ship v1 without music); post-production accepts it so that adding a
   * track later needs no change here.
   */
  musicUrl?: string | null;
  /**
   * The script and CTA the storyboard was planned around. Present for planned
   * generations, absent for the original path — which then writes its own, as
   * it always did.
   */
  plannedScript?: string | null;
  plannedCta?: string | null;
}): Promise<VoiceoverOutcome> {
  if (!openaiConfigured) {
    return {
      status: "skipped",
      reason: setupNotice("narration is unavailable right now", "OPENAI_API_KEY not configured"),
    };
  }

  const toolsMissing = await missingMediaTools();
  if (toolsMissing) {
    console.error("[video/postproduce] cannot narrate:", toolsMissing);
    return { status: "skipped", reason: toolsMissing };
  }

  // mkdtemp must be inside the try: it can fail (a full or read-only /tmp) and
  // this function's whole contract is that it degrades instead of throwing.
  // It also has to precede `finally`'s cleanup being able to reference tmpDir.
  let tmpDir: string | null = null;
  try {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zidaneai-vo-"));
    const silent = path.join(tmpDir, "silent.mp4");
    const speech = path.join(tmpDir, "vo.mp3");
    const voiced = path.join(tmpDir, "voiced.mp4");

    const res = await fetchPublicUrl(input.videoUrl, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`source fetch failed (${res.status})`);
    await fs.writeFile(silent, Buffer.from(await res.arrayBuffer()));

    // Already voiced (e.g. a re-run, or a provider that started emitting
    // audio) — leave it alone rather than layering a second narration. This is
    // terminal: the source will still have audio next time.
    if (await hasAudio(silent)) {
      return { status: "skipped", reason: "source clip already has an audio track" };
    }

    const sourceSec = await probeDuration(silent);
    const { width, height } = await probeDimensions(silent);

    // The delivered length. Never longer than the footage we actually have —
    // a clip short a failed take is short, and was refunded for it.
    const targetSec =
      input.targetDurationSec && input.targetDurationSec > 0
        ? Math.min(sourceSec, input.targetDurationSec)
        : sourceSec;

    // The spellings that outrank every model in this pipeline.
    const terms = canonicalTerms(input.profile);

    // Write the narration first: the end card's call to action comes out of the
    // same call, so the picture cannot be cut until the words exist.
    const { draft, spoken } = await narrationWithinBudget({
      prompt: input.prompt,
      kind: input.kind,
      seconds: targetSec,
      profile: input.profile,
      tone: input.tone,
      speechPath: speech,
      plannedScript: input.plannedScript,
      plannedCta: input.plannedCta,
      canonical: terms,
    });

    // The end card is a still we draw, never something the model renders — see
    // endcard.ts. A short clip gets a proportionally shorter card so a 5s ad
    // does not spend a third of itself on a logo.
    const cardSec = Math.min(ENDCARD_SECONDS, targetSec * 0.2);
    const endCard = await writeEndCardImage({
      dir: tmpDir,
      width,
      height,
      profile: input.profile,
      cta: draft.cta,
    }).catch((err) => {
      console.error("[video/postproduce] end card failed:", err);
      return null;
    });
    const endCardPath = endCard?.file ?? null;

    const picture = path.join(tmpDir, "picture.mp4");
    const { bodySec } = await buildPicture({
      videoPath: silent,
      outPath: picture,
      targetSec,
      endCardPath,
      cardSec,
      width,
      height,
    });

    const music = await fetchMusic(input.musicUrl, tmpDir);
    await mux(picture, speech, voiced, { musicPath: music });

    let final = voiced;
    let captionsBurned = false;
    let captionFontFallback = false;

    // Captions, in a treatment that suits the type (see captions.ts). Most
    // social video is watched muted, so a clip whose words live only in the
    // audio is a clip most viewers never hear — but a brand film and a TikTok
    // do not get the same lettering.
    //
    // The keyframe model is NOT asked to draw them. It renders the caption into
    // the frame, where DoP then animates it and the lettering warps — and the
    // generated text is only approximately the words that get spoken, because
    // the script is written after the frame. Compositing here means the
    // captions are the actual narration, spelled correctly, and stable.
    const captionStyle = CAPTION_STYLE_BY_KIND[input.kind];
    if (captionStyle) {
      const captioned = path.join(tmpDir, "captioned.mp4");
      try {
        const kit = input.profile?.brandKit;
        const ok = await addCaptions({
          videoPath: final,
          speech: spoken,
          outPath: captioned,
          width,
          height,
          brandKit: kit,
          style: captionStyle,
          canonicalTerms: terms,
          // Caption the script we wrote, not a transcription of it.
          scriptText: draft.script,
          stopAt: endCardPath ? bodySec : undefined,
        });
        if (ok.ok) {
          final = captioned;
          captionsBurned = true;
        }
        captionFontFallback = ok.fontFallback;
      } catch (err) {
        console.error("[video/postproduce] captions failed:", err);
      }
    }

    // Brand the finished clip with the real logo. Best-effort by design: an
    // unbranded clip is a fine outcome, a failed render is not — so any problem
    // here leaves `final` pointing at what came before it.
    const logo = await fetchLogo(input.profile, tmpDir);
    if (logo) {
      const branded = path.join(tmpDir, "branded.mp4");
      try {
        await overlayLogo(final, logo, branded, endCardPath ? bodySec : undefined);
        final = branded;
      } catch (err) {
        console.error("[video/postproduce] logo overlay failed:", err);
      }
    }

    // The last gate, and a purely local one: does the file we are about to
    // hand over match what the product claimed it would be? Duration, format
    // and the presence of an audio track are all promises the UI made on this
    // clip's behalf, and every one of them is measurable. Advisory — a clip
    // that fails is still delivered, because a flawed clip beats no clip — but
    // it is recorded, so a systematic failure shows up in the metrics rather
    // than in a support thread.
    const checks = await finalTechnicalCheck({
      videoPath: final,
      targetSec,
      targetWidth: width,
      targetHeight: height,
      expectAudio: true,
    });
    if (!checks.ok) {
      console.error(
        `[video/postproduce] finished clip failed its own checks: ${checks.problems.join("; ")}`,
      );
    }

    const durationSec = await probeDuration(final);
    const buf = await fs.readFile(final);
    const db = createAdminClient();
    const storagePath = `${input.workspaceId}/${input.jobId}-voiced.mp4`;
    const { error } = await db.storage
      .from("videos")
      .upload(storagePath, buf, { contentType: "video/mp4", upsert: true });
    if (error) throw new Error(`upload failed: ${error.message}`);

    const url = db.storage.from("videos").getPublicUrl(storagePath).data.publicUrl;
    return {
      status: "ok",
      url,
      script: draft.script,
      cta: endCardPath ? draft.cta : undefined,
      durationSec,
      checks: {
        ok: checks.ok,
        problems: checks.problems,
        // What branding actually made it onto the clip, as opposed to what was
        // intended. Both are best-effort steps that degrade silently by design,
        // so without this there is no way to tell an unbranded clip from a
        // brand with no logo.
        branding: {
          logo: !!logo,
          endCard: !!endCardPath,
          captions: captionsBurned,
        },
        // TRUE when the brand's own typeface could not be embedded and a
        // generic face was used instead. Recorded rather than left to the eye:
        // a fallback is invisible unless you know the brand's real font.
        fontFallback: (endCard?.fontFallback ?? true) || captionFontFallback,
      },
    };
  } catch (err) {
    console.error("[video/postproduce] voiceover failed:", err);
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
