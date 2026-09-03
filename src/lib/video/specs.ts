/**
 * What this product can make: video types, aspect ratios, clip lengths, and
 * the prompt seeds that go with them.
 *
 * The catalog half of `higgsfield.ts`, split out for the same reason
 * `social/platforms.ts` was split from `social/composio.ts`. The Video
 * Generator screen is `"use client"` and reads eleven things from here — the
 * kind picker, the format presets, the take lengths, the credit maths. It was
 * importing them from the module that also holds the provider REST client, so
 * `platform.higgsfield.ai` and the polling loop were measurably in the browser
 * bundle, unreachable and unusable there.
 *
 * Nothing in this file touches `env`, the network, or a key. `higgsfield.ts`
 * re-exports all of it, so no existing caller changed.
 *
 * The seam is exact rather than approximate: `env` was first read at what used
 * to be line 742, and everything above it was already pure.
 */

export type VideoKind =
  | "ugc"
  | "shortform"
  | "cinematic"
  | "avatar"
  | "demo";

/** Output aspect ratios, tagged to the platforms each one is made for. */
export type AspectRatio = "9:16" | "4:5" | "1:1" | "16:9";

/**
 * What one provider request actually returns.
 *
 * Every DoP model on this account renders a fixed ~5.4s take. The `duration`
 * field in the request body is accepted and then ignored: 5, 10 and 30 all come
 * back at 5.366667s (measured against the live API, three separate requests).
 * There is no longer-clip model in the catalog either — every video model is an
 * image2video DoP variant.
 *
 * So clip length is not something we can ask for; it is something we BUILD. A
 * take is the unit, and anything longer is several takes cut together (see
 * lib/video/stitch.ts and the assembly step in /api/video/status).
 *
 * The takes are shot in PARALLEL, all from one keyframe, each with its own
 * camera direction. Chaining them instead — animating each take from the
 * previous take's last frame — gives smoother continuity, and was the first
 * implementation, but a take takes 4-9 minutes to render: six of them in series
 * is a 30-50 minute wait that only advances while the browser is polling, so
 * closing the tab strands the job. In parallel the whole set renders in about
 * the time of the slowest take, at the provider, whether or not anyone is
 * watching.
 */
export const SEGMENT_SECONDS = 5.37;

/**
 * Trimmed off the head of every take after the first when the takes are
 * joined. All takes are animated from the same keyframe, so each one opens on
 * that identical frame; cutting straight from the end of one take to the start
 * of the next would snap the subject back to its opening pose. Half a second in
 * (15 frames) the camera has moved and the cut lands mid-motion.
 */
export const TAKE_HEAD_TRIM_SECONDS = 0.5;

/** Hard ceiling on takes per video — a runaway chain must not bill forever. */
export const MAX_SEGMENTS = 8;

/**
 * The real length of a clip cut from `takes` takes.
 *
 * Only the first take contributes its full ~5.37s. Every take after it is
 * trimmed at the head by TAKE_HEAD_TRIM_SECONDS when the cut is assembled (see
 * stitch.ts), so the footage that survives is shorter than the footage that was
 * rendered — and a length derived from SEGMENT_SECONDS alone overstates the
 * clip by half a second per cut.
 *
 * Verified against a real assembly: three live takes joined by concatTakes
 * measure 15.100s, which is exactly what this returns for 3.
 */
export function assembledSeconds(takes: number): number {
  const n = Math.max(1, Math.min(MAX_SEGMENTS, Math.round(takes)));
  return n * SEGMENT_SECONDS - (n - 1) * TAKE_HEAD_TRIM_SECONDS;
}

/**
 * Every clip length the generator can actually produce: [5, 10, 15, 20, 25, 30,
 * 35, 39], one per take count.
 *
 * A length is not a free parameter. The provider renders a fixed ~5.37s take
 * and ignores the duration we ask for, so a clip is ALWAYS a whole number of
 * takes cut together — which makes the take the real unit and seconds a label
 * for it.
 *
 * This replaced a hardcoded [5, 10, 15, 30]. Those four mapped to 1, 2, 3 and 6
 * takes, so four of the eight lengths the engine could build were simply
 * unreachable, and the three above 5s were labelled with a length no clip ever
 * had.
 *
 * The label comes from assembledSeconds, not from SEGMENT_SECONDS alone. The
 * first pass at this fix used the raw take length and so reintroduced the same
 * class of error in the other direction: it ignored the head trim, and promised
 * a "32s" clip that measured 29.7s. Both numbers now come from one formula, so
 * the label cannot drift from the footage again.
 */
export const TAKE_LENGTHS: readonly number[] = Array.from(
  { length: MAX_SEGMENTS },
  (_, i) => Math.round(assembledSeconds(i + 1)),
);

/** Shortest and longest clip that can be built, in seconds. */
export const MIN_DURATION = TAKE_LENGTHS[0];
export const MAX_DURATION = TAKE_LENGTHS[MAX_SEGMENTS - 1];

/**
 * A clip length in seconds. Deliberately a plain number rather than a union of
 * literals: length is now continuous input that gets snapped, so the type
 * cannot enumerate what is valid — `normalizeDuration` decides that.
 */
export type VideoDuration = number;

/** Default length for a new generation — six takes, the old "30s". */
export const DEFAULT_DURATION: VideoDuration = TAKE_LENGTHS[5];

/**
 * How many provider takes a target length needs.
 *
 * Nearest take, not `ceil`. Ceiling always rounded UP to a whole take, so a 6s
 * request became two takes (10.7s of footage) and — now that length is billed —
 * was charged for two. Nearest gives the user the clip closest to what they
 * asked for and bills for exactly that.
 *
 * Every length the old picker offered maps to the same take count it did
 * before: 5→1, 10→2, 15→3, 30→6. So this is not a repricing of anything that
 * already exists, including rows generated before the change.
 */
export function segmentsForDuration(sec: number): number {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return 1;
  let best = 1;
  for (let takes = 1; takes <= MAX_SEGMENTS; takes++) {
    if (Math.abs(assembledSeconds(takes) - sec) < Math.abs(assembledSeconds(best) - sec)) {
      best = takes;
    }
  }
  return best;
}

/** Snap any requested length to one the generator can actually build. */
export function normalizeDuration(sec?: number | null): VideoDuration {
  if (!sec || !Number.isFinite(sec) || sec <= 0) return DEFAULT_DURATION;
  return TAKE_LENGTHS[segmentsForDuration(sec) - 1];
}

/**
 * Pull an explicit "N second" request out of free-text so a prompt like
 * "make it a 20-second ad" still drives the length when no duration was picked
 * in the UI. Returns the raw number (unclamped) or undefined.
 */
export function parseDurationFromText(text?: string | null): number | undefined {
  if (!text) return undefined;
  const m = text.match(/(\d{1,3})\s*(?:-|\s)?\s*(?:s\b|sec|secs|second|seconds)/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface VideoJob {
  id: string;
  status: "queued" | "processing" | "completed" | "failed";
  kind: VideoKind;
  prompt: string;
  url?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  aspectRatio?: AspectRatio;
  createdAt: string;
  /**
   * What was actually sent to the provider — the keyframe prompt when one was
   * generated, plus take 0's video prompt. Persisted for debugging: it is the
   * only record of why a clip looks the way it does, so it must describe the
   * requests that were really made rather than the ones we composed.
   */
  providerPrompt?: string;
  /** Every take making up this clip, in cut order. One entry for a 5s clip. */
  takes?: TakeRef[];
  /** Takes finished / takes needed, for "Take 3 of 6" while a clip renders. */
  progress?: { done: number; total: number };
  /**
   * Why this generation failed, in words the generator can show.
   *
   * Generation is asynchronous end to end: the request that started a clip
   * returned 202 long before anything could go wrong with it, so a failure has
   * no response left to explain itself through. The reason is recorded on the
   * row and read back here — otherwise a demo of an unreachable URL is just a
   * card marked "failed" with no way to know what to fix.
   */
  error?: string;
  /**
   * Demos only: the capture read this workspace's own brand off the page and
   * saved it, so the Brand style panel is now showing stale colours.
   *
   * It used to be a field on the generate response, back when a demo finished
   * inside its own request. The capture happens minutes later and in another
   * process now, so the signal has to travel with the job instead.
   */
  brandKitSaved?: boolean;
}

export interface VideoProvider {
  readonly name: string;
  readonly live: boolean;
  create(input: {
    kind: VideoKind;
    prompt: string;
    /**
     * What the KEYFRAME is drawn from. Defaults to `prompt`.
     *
     * They differ when the caller is an agent: `prompt` is the intent, and it
     * is what gets stored on the row and what the narration is written from,
     * so it has to stay whole. The keyframe needs one photographable scene
     * instead — see lib/video/brief.
     */
    visualPrompt?: string;
    assetUrl?: string;
    aspectRatio?: AspectRatio;
    /** Requested clip length; snapped to a supported value before sending. */
    durationSec?: number;
  }): Promise<VideoJob>;
  status(id: string, kind?: VideoKind, prompt?: string): Promise<VideoJob>;
}

/** One take of a clip: its position in the cut and the request that renders it. */
export interface TakeRef {
  index: number;
  requestId: string;
}

/**
 * Camera directions, one per take, applied in order — PER TYPE.
 *
 * Every take starts from the same keyframe, so without these the model shoots
 * the same beat six times and the finished clip reads as a stutter. With them
 * the shots differ the way an editor's coverage differs — same set, same
 * subject, different lens and movement — and cut together into something that
 * looks deliberately edited.
 *
 * These used to be ONE list, shared by every type, and it was written for
 * cinematic. That quietly cancelled a good part of what picking a type is
 * supposed to do, because the directions are appended AFTER `spec.motion` and
 * so get the last word. The worst case was `avatar`, whose motion line ends
 * "the camera stays locked off" — and which then asked, on takes 3 through 8,
 * for an orbit, a handheld step to the side and a crane up into a wide shot.
 * Seven of the eight takes in a 39s talking-head clip were instructed to do
 * the exact thing the type forbids. UGC had the mirror problem: a phone held
 * at arm's length cannot crane.
 *
 * So each type gets coverage it can actually shoot. Same length as
 * MAX_SEGMENTS, so no type wraps before the ceiling moves.
 */
const SHOT_DIRECTIONS: Record<VideoKind, readonly string[]> = {
  // Phone at arm's length. Everything has to be achievable one-handed.
  ugc: [
    "Open on this framing and hold it, the phone drifting slightly as they talk.",
    "They bring the phone closer to their face for emphasis, filling more of the frame.",
    "They turn the phone to show the product, then bring it back to themselves.",
    "A quick handheld reframe as they shift their weight and keep talking.",
    "They hold the product up next to their face, close to the lens.",
    "The arm extends slightly, opening the shot out to show more of the room.",
    "They lean in toward the lens to make a point, the framing tightening.",
    "They gesture with their free hand, the phone bobbing with the movement.",
  ],
  // Energy comes from speed of movement, not from elaborate rigging.
  shortform: [
    "Open on this framing with a fast push straight in toward the subject.",
    "Snap to a tighter framing on the subject's hands and the product.",
    "A quick whip of the camera to the side, settling hard on the subject.",
    "Punch in fast, then hold dead still on the subject's face.",
    "Rapid pull back, opening the frame out in one sharp move.",
    "The camera drops low and pushes up at the subject from below.",
    "A fast lateral swing past the subject, the product staying centred.",
    "Push in hard to an extreme close-up on the product and hold.",
  ],
  // The original list — it was always written for this type.
  cinematic: [
    "Open on this framing and hold it, with a slow push in toward the subject.",
    "Move to a tighter shot: the camera drifts in close on the subject's hands and the product detail.",
    "Orbit slowly around the subject, keeping them centered as the background sweeps behind them.",
    "Rack focus from the foreground to the subject, then tilt up to their face as they react.",
    "Handheld reframe: a quick step to the side, then settle into a low three-quarter angle.",
    "Pull back and crane up into a wide shot that reveals the whole space.",
    "Slow lateral track past the subject, the product staying in frame.",
    "Push in hard to a close-up, then hold on the product as the light shifts.",
  ],
  // Locked off, by definition. The variation is in the presenter, not the rig.
  avatar: [
    "Hold this framing exactly, the camera locked off as the presenter speaks.",
    "Hold the framing; the presenter leans in slightly to emphasise a point.",
    "Hold the framing; the presenter gestures once toward the lens as they talk.",
    "An almost imperceptible slow push in, the presenter otherwise still.",
    "Hold the framing; the presenter tilts their head and pauses before continuing.",
    "Hold the framing; the presenter opens both hands in front of them mid-sentence.",
    "An almost imperceptible slow pull back, the presenter holding their position.",
    "Hold the framing; the presenter nods once and settles, addressing the lens.",
  ],
  // Never reached — a demo is a Playwright screen recording, not a render.
  // Present so the map stays exhaustive over VideoKind.
  demo: [
    "Hold on the interface, steady and legible.",
    "Move down the interface, holding on each feature long enough to read.",
    "Push in on the control being described.",
    "Pull back to show where this sits in the whole screen.",
    "Move across to the next area of the interface.",
    "Hold steady on the result of the action.",
    "Push in on the detail that changed.",
    "Settle back on the full interface and hold.",
  ],
} as const;

/**
 * How much of the scene rides along on each take request.
 *
 * Short on purpose. The keyframe already carries the look, so this is a
 * reminder of WHAT is being filmed, not a second brief competing with the
 * image the model is animating.
 */
const TAKE_SCENE_LIMIT = 240;

/**
 * The prompt for take `index`: what is in the shot, how it moves, and that
 * take's own camera direction. Takes past the list wrap around — with
 * MAX_SEGMENTS at 8 that is only reachable if the ceiling moves.
 *
 * `scene` used to be missing entirely: the video model received
 * `spec.motion` plus a camera direction and nothing else, so not one word the
 * user typed reached the model that renders the footage. That was survivable
 * only while the keyframe was always generated FROM those words — the moment a
 * supplied asset skipped the keyframe step, the prompt stopped reaching any
 * model at all and every clip came out identical regardless of what was asked
 * for. Passing the scene here means the request is grounded either way, and it
 * is also the only place a motion instruction someone actually typed ("slow
 * zoom out", "whip pan") can land.
 *
 * Takes the KIND rather than a motion string so the type's own motion line and
 * its own shot coverage are read from one place and cannot be paired with each
 * other's — which is how avatar ended up asking for a crane.
 */
export function promptForTake(
  scene: string,
  kind: VideoKind,
  index: number,
): string {
  const spec = specForKind(kind);
  const directions = SHOT_DIRECTIONS[kind];
  const direction = directions[index % directions.length];
  // Take 0 gets a direction too. It used to be skipped, which left
  // SHOT_DIRECTIONS[0] — "Open on this framing and hold it, with a slow push
  // in" — dead in the array despite being written for exactly that take, and
  // left the opening shot with no camera instruction at all.
  // Cut on a word boundary. `brief.ts` makes the same point about its own
  // trimming: a scene that stops at "...and advanced technology, with" reads to
  // the model as corrupted input, which is worse than a shorter scene.
  const full = scene.trim();
  let subject = full;
  if (full.length > TAKE_SCENE_LIMIT) {
    const cut = full.slice(0, TAKE_SCENE_LIMIT);
    const space = cut.lastIndexOf(" ");
    subject = (space > 0 ? cut.slice(0, space) : cut).trim();
  }
  return [subject, spec.motion, direction].filter(Boolean).join(" ").trim();
}

// ---------------------------------------------------------------------------
// Type + format specs — the single source of truth shared by the API route,
// the provider, and the Video Generator UI. Each video TYPE injects its own
// style + default format so switching types genuinely changes the output;
// each FORMAT maps an aspect ratio to real pixel dimensions and the social
// platforms it's meant for.
// ---------------------------------------------------------------------------

export interface AspectPreset {
  id: AspectRatio;
  /** Human label, e.g. "Vertical". */
  label: string;
  width: number;
  height: number;
  /** Social platforms this ratio is the native/preferred format for. */
  platforms: string[];
  /** Natural-language framing appended to the prompt — always safe to send. */
  frame: string;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  {
    id: "9:16",
    label: "Vertical",
    width: 1080,
    height: 1920,
    platforms: ["Instagram Reels", "Stories", "TikTok"],
    frame: "Composed full-bleed as a 9:16 vertical video.",
  },
  {
    id: "4:5",
    label: "Portrait",
    width: 1080,
    height: 1350,
    platforms: ["Instagram Feed"],
    frame: "Composed as a 4:5 portrait video sized for the feed.",
  },
  {
    id: "1:1",
    label: "Square",
    width: 1080,
    height: 1080,
    platforms: ["Instagram Feed", "LinkedIn"],
    frame: "Composed as a 1:1 square video.",
  },
  {
    id: "16:9",
    label: "Landscape",
    width: 1920,
    height: 1080,
    platforms: ["LinkedIn", "YouTube"],
    frame: "Composed as a 16:9 widescreen landscape video.",
  },
] as const;

export function presetForRatio(r?: AspectRatio): AspectPreset {
  return ASPECT_PRESETS.find((p) => p.id === r) ?? ASPECT_PRESETS[0];
}

/**
 * Longest edge a product-demo recording is captured at.
 *
 * A demo is a real browser recording, not a render, and Playwright records at
 * the viewport size — so a full 1920x1080 viewport means a 1920x1080 browser
 * doing 1920x1080 of compositing for the length of the capture. Capping the
 * long edge keeps that affordable, at a size still comfortably above what a
 * feed plays back at.
 */
export const DEMO_CAPTURE_LONG_EDGE = 1280;

/**
 * The pixel size a demo is really recorded at, for the chosen ratio.
 *
 * Lives here rather than in capture.ts because the Video Generator has to be
 * able to state it, and capture.ts pulls in Playwright — which has no business
 * in a client bundle. The UI printed the full preset dimensions for every type,
 * so a product demo advertised 1920x1080 and delivered 1280x720.
 */
export function demoCaptureSize(ratio?: AspectRatio): { width: number; height: number } {
  const p = presetForRatio(ratio);
  const scale = Math.min(1, DEMO_CAPTURE_LONG_EDGE / Math.max(p.width, p.height));
  const even = (n: number) => Math.max(2, Math.round((n * scale) / 2) * 2);
  return { width: even(p.width), height: even(p.height) };
}

/**
 * Is this one of the four formats the product offers?
 *
 * `presetForRatio` falls back to 9:16 for anything it does not recognise,
 * which is the right behaviour for a lookup and the wrong one for a request
 * boundary: it turns "16:9" typed with a stray space into a vertical video
 * with nothing said about it. Routes validate with this and refuse instead.
 */
export function isAspectRatio(v: unknown): v is AspectRatio {
  return typeof v === "string" && ASPECT_PRESETS.some((p) => p.id === v);
}

export interface VideoKindSpec {
  id: VideoKind;
  label: string;
  /**
   * One-line description shown under the type selector, and the editorial
   * register handed to the narration writer in postproduce.
   */
  blurb: string;
  /**
   * The LOOK of the still keyframe: subject, setting, light, composition.
   *
   * This was one `style` field sent to BOTH models. The keyframe generator is a
   * still-image model, so temporal directives reached it that it could not act
   * on — "a strong hook in the first two seconds", "punchy quick cuts",
   * "natural lip-sync". They did not merely do nothing: they competed for
   * attention with the scene description, and that one frame is what every
   * take animates from, so a diluted keyframe is a diluted clip six times over.
   *
   * Nothing about time or motion belongs here.
   */
  keyframe: string;
  /**
   * How the take MOVES. Sent only to the video model, which already has the
   * keyframe for the look — so this stays about motion and nothing else.
   */
  motion: string;
  /** Default clip length — always one of TAKE_LENGTHS. */
  defaultDurationSec: VideoDuration;
  defaultAspect: AspectRatio;
  /**
   * Kept out of the picker, but still accepted by the API.
   *
   * Hiding rather than deleting, because a type is not only a menu entry: it is
   * a price key, a `kind` on every historical row, and a value the status route
   * reads back. Deleting `avatar` would leave stored clips referring to a type
   * the code no longer knows, and `specForKind` answers "ugc" for an unknown
   * type — so every past avatar clip would quietly re-describe itself as a UGC
   * ad. Hidden types keep working for what already exists and stop being
   * offered for what doesn't.
   */
  hidden?: boolean;
}

/** The types the generator offers. `VIDEO_KIND_SPECS` keeps the hidden ones. */
export function selectableKindSpecs(): readonly VideoKindSpec[] {
  return VIDEO_KIND_SPECS.filter((s) => !s.hidden);
}

export const VIDEO_KIND_SPECS: readonly VideoKindSpec[] = [
  {
    id: "ugc",
    label: "UGC ad",
    blurb: "Authentic, handheld selfie-style ad from a real person to camera.",
    keyframe:
      "Photographic still of a real person filming themselves on a phone held at arm's length, in a lived-in room lit by a window. Candid mid-sentence expression, slightly off-centre handheld framing, shallow depth of field.",
    motion:
      "Handheld micro-movement with small natural drift; the subject gestures and shifts their weight as they speak.",
    defaultDurationSec: DEFAULT_DURATION,
    defaultAspect: "9:16",
  },
  {
    id: "shortform",
    label: "Short-form",
    blurb: "Punchy, fast-cut social clip built to stop the scroll.",
    // "A strong hook in the first two seconds" and "punchy quick cuts" were
    // asking a 5.37s single take to cut, and asking a still image to have a
    // first two seconds. The energy has to come from the composition instead.
    keyframe:
      "Photographic still with one bold, immediately readable subject filling the frame. High-contrast lighting, saturated colour, strong graphic composition that reads at a glance on a phone.",
    motion:
      "Snappy high-energy movement: a quick push toward the subject as they make one emphatic gesture.",
    defaultDurationSec: DEFAULT_DURATION,
    defaultAspect: "9:16",
  },
  {
    id: "cinematic",
    label: "Cinematic",
    blurb: "Premium, color-graded commercial with dramatic camera moves.",
    keyframe:
      "Cinematic film still: dramatic directional lighting, deep shadows, shallow depth of field, rich filmic colour grade, premium production design.",
    motion:
      "One slow deliberate camera move — a smooth dolly in, or a gentle crane — with the subject nearly still.",
    defaultDurationSec: DEFAULT_DURATION,
    defaultAspect: "16:9",
  },
  {
    id: "avatar",
    label: "Talking avatar",
    blurb: "A presenter speaking straight to camera, studio-clean.",
    // HIDDEN until a model on this account can actually lip-sync.
    //
    // The keyframe comment below has said for a while that DoP cannot do it:
    // it is image2video with no audio input, and the voice is synthesized by
    // TTS minutes later in postproduce. So the one thing this type is FOR — a
    // person whose mouth matches the words — is the one thing it cannot do,
    // and what shipped was a presenter mouthing unrelated syllables over a
    // voiceover. Every other type degrades gracefully when a model is weak;
    // this one degrades into the uncanny valley, which is why it is the only
    // type withdrawn rather than tuned. Re-list it by deleting `hidden` on the
    // day a lip-sync model appears in the catalogue.
    hidden: true,
    // "Natural lip-sync" was a promise this pipeline cannot keep: DoP is
    // image2video with no audio input, and the voiceover is synthesized by TTS
    // minutes later in postproduce. Asking for sync only produced mouth motion
    // that reads as badly dubbed. Frame it as a held address instead.
    keyframe:
      "Photographic still of a single presenter framed head-and-shoulders against a clean studio backdrop, soft key light, direct eye contact with the lens.",
    motion:
      "The presenter holds their position and addresses the lens with small natural head movement; the camera stays locked off.",
    defaultDurationSec: DEFAULT_DURATION,
    defaultAspect: "1:1",
  },
  {
    id: "demo",
    label: "Product demo",
    blurb: "Clean product walkthrough with clear feature callouts.",
    // A demo is a Playwright screen recording, so neither string below is ever
    // sent to a model — but `defaultAspect` IS live: it feeds captureViewport.
    // It was "1:1", which recorded web apps into a 1080x1080 square.
    keyframe:
      "Crisp product screenshot, bright even lighting, the interface square to frame and legible.",
    motion:
      "Steady move through the interface, holding on each feature long enough to read.",
    defaultDurationSec: DEFAULT_DURATION,
    defaultAspect: "16:9",
  },
] as const;

/**
 * How many takes the default clip is worth. The price book quotes the price of
 * a DEFAULT clip, so this is the divisor that turns a listed price into a
 * per-take one.
 */
const DEFAULT_TAKES = segmentsForDuration(DEFAULT_DURATION);

/**
 * What a clip actually costs, in credits.
 *
 * Length was free before this: every clip cost `CREDIT_COST[kind]` no matter
 * how long it was. But a 30-second clip is SIX provider renders and a 5-second
 * clip is one, so the cheapest thing a user could do was also the most
 * expensive thing we could serve — and the rational move was always to pick 30s.
 *
 * Scaling is anchored at the DEFAULT length, not at one take: the listed price
 * stays the price of the clip most people generate, and shorter clips get
 * cheaper. Anchoring at a take instead would have multiplied the default by six
 * — a 100-credit starter grant would not have covered a single video.
 *
 * `listedPrice` is passed in rather than read from the price book because this
 * runs on both sides: the server has CREDIT_COST, the browser has the prices
 * /api/credits handed it. One formula, two callers, so the number quoted on the
 * button and the number charged by the route cannot drift apart.
 *
 * Product demos are flat — one Playwright capture is one capture, and its
 * length is a property of the page being recorded, not of anything the user
 * chose or we spent more on.
 */
export function videoCreditCost(input: {
  listedPrice: number;
  kind: VideoKind;
  durationSec?: number | null;
  count?: number;
}): number {
  const count = Math.max(1, Math.round(input.count ?? 1));
  const listed = Math.max(0, input.listedPrice);
  if (input.kind === "demo") return Math.round(listed) * count;

  const takes = segmentsForDuration(normalizeDuration(input.durationSec));
  const scaled = Math.ceil((listed * takes) / DEFAULT_TAKES);
  // A priced action never rounds down to free.
  return (listed > 0 ? Math.max(1, scaled) : 0) * count;
}

export function specForKind(kind: VideoKind): VideoKindSpec {
  return VIDEO_KIND_SPECS.find((s) => s.id === kind) ?? VIDEO_KIND_SPECS[0];
}

/**
 * Is this one of the five video types?
 *
 * Same reasoning as `isAspectRatio`: `specForKind` silently answers "ugc" for
 * an unknown type, so an unvalidated `kind` produced a UGC clip while the
 * price book was indexed by the string the caller sent — a type nobody offers,
 * billed at a price nobody quoted.
 */
export function isVideoKind(v: unknown): v is VideoKind {
  return typeof v === "string" && VIDEO_KIND_SPECS.some((s) => s.id === v);
}

/**
 * Seed values pulled from the workspace brand profile so the suggested prompt
 * is about the user's actual product and audience. Everything is optional —
 * sensible generic defaults fill the gaps.
 */
export interface PromptSeed {
  product?: string;
  audience?: string;
}

/**
 * The default prompt shown in the Video Generator's textarea. It changes with
 * the selected TYPE (a UGC prompt reads differently from a cinematic one) and
 * is grounded in the user's product/audience when their brand profile is set.
 */
export function defaultPromptForKind(kind: VideoKind, seed: PromptSeed = {}): string {
  const product = seed.product?.trim() || "an AI productivity app";
  const audience = seed.audience?.trim() || "a young founder";
  switch (kind) {
    case "ugc":
      return `A UGC-style ad for ${product}, showing ${audience} using it in a real moment. Energetic, authentic, natural lighting.`;
    case "shortform":
      return `A punchy short-form video for ${product}. Open with a scroll-stopping hook, then fast cuts and bold captions aimed at ${audience}.`;
    case "cinematic":
      return `A cinematic brand film for ${product}. Dramatic lighting, shallow depth of field and sweeping camera moves — premium and aspirational, resolving on the logo.`;
    case "avatar":
      return `A talking-head video: a friendly presenter speaks straight to camera, explaining ${product} to ${audience}. Clean studio background, warm and trustworthy.`;
    case "demo":
      // No "on-screen callouts": a demo is a Playwright recording of the real
      // page (see capture.ts), and nothing in that path draws annotations. The
      // prompt reaches the NARRATION only, so it should describe what is said
      // over the walkthrough — promising graphics the pipeline cannot draw is
      // how this control looked broken when it was merely aimed elsewhere.
      return `A clean product demo of ${product}, narrated for ${audience} — walk through the top features and say what each one does.`;
    default: {
      // Exhaustiveness guard: a new VideoKind must add a prompt above.
      const _never: never = kind;
      return `A short brand video for ${product}.` + (_never ?? "");
    }
  }
}

