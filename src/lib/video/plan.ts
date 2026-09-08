import { chatJSON } from "@/lib/ai/openai";
import {
  brandContext,
  brandKnowsProduct,
  narrationLanguage,
  type BrandProfile,
} from "@/lib/brand";
import { specForKind, SEGMENT_SECONDS, type VideoKind } from "@/lib/video/higgsfield";
import { CONTENT_TONES, TONE_LABEL, type ContentTone } from "@/lib/ai/content";

/**
 * The plan: what the video SAYS, and what each shot shows while it says it.
 *
 * This is the stage the old pipeline did not have. It distilled the prompt into
 * one photographable sentence, rendered one still, and animated that same still
 * once per take — so a six-take clip was six camera moves around a single
 * frozen moment, and the narration was written afterwards, against a video that
 * had already been shot. Nothing planned anything.
 *
 * Here the words come first and the pictures serve them:
 *
 *   1. Three scripts, deliberately different in angle.
 *   2. A critique that scores all three and picks one, with reasons.
 *   3. A storyboard: one intentional shot per ~5.37s take, each carrying the
 *      line it covers, what is in frame, and how it moves.
 *
 * Three model calls per video, before a single provider credit is spent. That
 * ordering is the point — it is far cheaper to throw away a bad script than a
 * bad render.
 */

/**
 * What a shot is made of.
 *
 *  - `generated`         DoP animates a keyframe we generated. The default.
 *  - `product_asset`     The user's own product image is the keyframe, so the
 *                        product on screen is the real one.
 *  - `playwright_capture` A real screen recording of the real product. No
 *                        provider render at all — when accuracy is what
 *                        matters, a recording beats anything generative.
 *  - `end_card`          Drawn deterministically in post (see endcard.ts).
 *                        Never rendered, never animated, always last.
 */
export type ShotKind = "generated" | "product_asset" | "playwright_capture" | "end_card";

export interface Shot {
  index: number;
  kind: ShotKind;
  /** The words spoken over this shot. Empty for the end card. */
  line: string;
  /** One sentence describing the FRAME. This is what the keyframe is drawn from. */
  visual: string;
  /** How the shot moves. This is what rides on the DoP request. */
  direction: string;
  /** Set on the hook and the product beat — where a second candidate is worth it. */
  critical?: boolean;
}

export interface VideoPlan {
  /** The winning narration, whole. */
  script: string;
  /** The end card's call to action. */
  cta: string;
  /** Why this script won. Stored, not shown — it is how a bad pick is diagnosed. */
  critique: string;
  /** How many scripts were considered. */
  considered: number;
  /**
   * The look every keyframe must share: one subject, one place, one light.
   *
   * Without this each shot is drawn independently and the clip cuts between
   * six different people in six different rooms. It is prepended to every
   * keyframe prompt and is the anchor the master frame establishes.
   */
  styleAnchor: string;
  shots: Shot[];
}

const PLAN_TIMEOUT_MS = 90_000;

/**
 * Planning is where quality is decided, so it does not run on the cheap default
 * model the rest of the app uses for extraction. Same model post-production
 * already writes narration with, so the plan and the final read agree about
 * what good copy sounds like.
 */
const PLAN_MODEL = "gpt-4o";

/** Shots that cost a provider render. The other kinds are made locally. */
export function renderableShots(shots: Shot[]): Shot[] {
  return shots.filter((s) => s.kind === "generated" || s.kind === "product_asset");
}

interface Candidate {
  angle: string;
  script: string;
  cta: string;
}

/**
 * Three scripts in one call, required to differ in ANGLE rather than in wording.
 *
 * One call rather than three because the model writing all three at once can
 * see them side by side, and asking for "three different approaches" in a
 * single completion reliably produces three different approaches — where three
 * independent calls at the same temperature produce three paraphrases of the
 * same idea, which is not a choice.
 */
async function writeCandidates(input: {
  prompt: string;
  kind: VideoKind;
  seconds: number;
  words: number;
  profile?: BrandProfile | null;
  tone?: ContentTone | null;
}): Promise<Candidate[]> {
  const spec = specForKind(input.kind);
  const language = narrationLanguage(input.profile);
  const brand = brandContext(input.profile ?? null, { includeResearch: false });
  // Whether anything actually describes the product. When nothing does, this
  // stage has to change what it OPTIMISES FOR, not merely be told to be careful
  // — see the grounding block below and the inverted criteria in
  // selectCandidate.
  const knowsProduct = brandKnowsProduct(input.profile ?? null, { includeResearch: false });
  const toneLine = input.tone
    ? `Layer a ${TONE_LABEL[input.tone]} tone on top WITHOUT overriding the brand's own voice.`
    : `Choose the tone that makes THIS concept land best — one of: ${CONTENT_TONES.map(
        (t) => TONE_LABEL[t],
      ).join("; ")}. Layer it on WITHOUT overriding the brand's own voice.`;

  const out = await chatJSON<{ candidates?: Candidate[] }>(
    [
      {
        role: "system",
        content:
          "You are a direct-response copywriter for short brand video.\n" +
          'Return STRICT JSON: {"candidates":[{"angle":"...","script":"...","cta":"..."}]} ' +
          "with EXACTLY three candidates.\n" +
          "The three must take genuinely different approaches — not three " +
          "rewrites of one idea. Vary what the opening line DOES: a problem " +
          "someone recognises, a result stated flatly, a moment of friction, a " +
          "direct claim, a question. If two candidates could be swapped without " +
          "anyone noticing, you have written the same script twice.\n" +
          "`script` is ONLY the spoken words: no scene directions, no speaker " +
          "labels, no quotes, no emoji, no markdown, sentence case.\n" +
          "`cta` is for the end card, not spoken: at most five words, " +
          "imperative, title case, no punctuation, no URL.\n" +
          "`angle` names the approach in a few words.\n" +
          // With no product facts available, "open strong" and "be specific"
          // can only be satisfied by making something up — and the critique
          // stage then rewards whichever candidate did so most confidently.
          // Name the constraint here, where the writing happens, rather than
          // relying on a caution buried in the brand block.
          (knowsProduct
            ? ""
            : "GROUNDING: nothing is known about what this product does beyond " +
              "its name. Write ONLY from the concept given. Do not name a " +
              "category, a competitor, a feature, a metric, an integration or a " +
              "problem it solves unless the concept states it — an invented " +
              "specific is a defect, not a strength, however well it reads. " +
              "Build the hook from the person, the moment or the audience " +
              "instead of from a capability you cannot verify.\n") +
          `Write every script and cta in ${language}, and in ${language} only. ` +
          "The brand details below are context, not a language instruction.",
      },
      {
        role: "user",
        content:
          `Three candidate voiceovers for this ${spec.label} video.\n\n` +
          `Concept: ${input.prompt}\n` +
          `Format: ${spec.blurb}\n` +
          (brand ? `${brand}\n` : "") +
          `\n${toneLine}\n` +
          `\nEach script: about ${input.words} words — speakable in ` +
          `${input.seconds.toFixed(1)} seconds at an unhurried pace. ` +
          `Open strong; end on a clear beat.`,
      },
    ],
    {
      // 0.95 buys three genuinely different angles when there is a product to
      // have angles ON. With nothing known, the same heat is spent inventing
      // three different products, so it is pulled back to where the model
      // stays close to the brief it was actually given.
      temperature: knowsProduct ? 0.95 : 0.45,
      maxTokens: 1200,
      timeoutMs: PLAN_TIMEOUT_MS,
      model: PLAN_MODEL,
    },
  );

  return (out?.candidates ?? [])
    .filter((c) => typeof c?.script === "string" && c.script.trim())
    .map((c) => ({
      angle: String(c.angle ?? "").trim().slice(0, 80),
      script: c.script.trim().replace(/^["'`]+|["'`]+$/g, ""),
      cta: String(c.cta ?? "").trim().replace(/^["'`]+|["'`]+$/g, "").slice(0, 60),
    }));
}

/**
 * Score the candidates and pick one.
 *
 * A separate call from the writing on purpose. A model asked to write three
 * things and immediately pick its favourite picks the last one it wrote about
 * as often as the best one; asked to judge a list it did not just produce, in a
 * turn whose only job is judging, it applies the criteria it was given.
 */
async function selectCandidate(input: {
  candidates: Candidate[];
  prompt: string;
  kind: VideoKind;
  seconds: number;
  profile?: BrandProfile | null;
}): Promise<{ index: number; critique: string }> {
  const spec = specForKind(input.kind);
  const brand = brandContext(input.profile ?? null, { includeResearch: false });
  const knowsProduct = brandKnowsProduct(input.profile ?? null, { includeResearch: false });

  const out = await chatJSON<{ winner?: number; critique?: string }>(
    [
      {
        role: "system",
        content:
          "You are a critical creative director choosing between scripts.\n" +
          'Return STRICT JSON: {"winner": <0-based index>, "critique": "..."}.\n' +
          "Judge on, in order of weight:\n" +
          "1. Does the first line stop someone scrolling?\n" +
          "2. Does it sound like THIS brand, not like generic marketing?\n" +
          // Criterion 3 and the penalty line INVERT when nothing is known about
          // the product. Left as written, they ask which candidate is most
          // specific about a product the judge has no facts on — a question
          // only a fabrication can win. Measured: for a portfolio site with no
          // analysis, this stage chose "Tired of juggling countless growth
          // tools" and rejected the honest candidate as "vague claims that
          // could apply to any product". The judge was working correctly
          // against criteria that had become wrong.
          (knowsProduct
            ? "3. Is it specific about the product rather than about feelings?\n"
            : "3. Does it avoid asserting anything the brief does not support?\n") +
          "4. Will it fit the time without rushing?\n" +
          "5. Does it end somewhere, rather than trailing off?\n" +
          (knowsProduct
            ? "Penalise clichés, hollow superlatives and anything that could " +
              "describe a different company unchanged.\n"
            : "NOTHING is known about what this product does beyond its name. A " +
              "candidate that invents a category, feature, metric, integration " +
              "or problem-it-solves is DISQUALIFIED no matter how well it reads. " +
              "Prefer a script that claims less and stays true over one that " +
              "sounds specific by guessing, and never fault a candidate merely " +
              "for being unspecific about the product. Still penalise clichés " +
              "and hollow superlatives.\n") +
          "`critique` is two sentences: why the winner won, and the one thing " +
          "the others got wrong.",
      },
      {
        role: "user",
        content:
          `A ${spec.label} video, ${input.seconds.toFixed(1)} seconds.\n` +
          `Concept: ${input.prompt}\n` +
          (brand ? `${brand}\n` : "") +
          `\nCandidates:\n` +
          input.candidates
            .map((c, i) => `[${i}] angle: ${c.angle}\n${c.script}`)
            .join("\n\n"),
      },
    ],
    { temperature: 0.2, maxTokens: 400, timeoutMs: PLAN_TIMEOUT_MS, model: PLAN_MODEL },
  );

  const raw = typeof out?.winner === "number" ? out.winner : 0;
  const index = Number.isInteger(raw) && raw >= 0 && raw < input.candidates.length ? raw : 0;
  return { index, critique: String(out?.critique ?? "").trim().slice(0, 500) };
}

interface RawShot {
  line?: string;
  visual?: string;
  direction?: string;
  useProductAsset?: boolean;
  useScreenRecording?: boolean;
}

/**
 * Break the winning script into one shot per take.
 *
 * The shot count is fixed by what was billed, not chosen by the model: a clip
 * is a whole number of ~5.37s takes and the user paid for a specific number of
 * them. So the model is dividing a known script across a known number of
 * frames, which is a much easier question than "how many shots should this be".
 */
async function writeStoryboard(input: {
  script: string;
  prompt: string;
  kind: VideoKind;
  shotCount: number;
  profile?: BrandProfile | null;
  hasProductAsset: boolean;
  canRecordScreen: boolean;
}): Promise<{ styleAnchor: string; shots: RawShot[] }> {
  const spec = specForKind(input.kind);
  const brand = brandContext(input.profile ?? null, { includeResearch: false });

  const affordances = [
    input.hasProductAsset
      ? "- `useProductAsset: true` on any shot whose subject IS the product. The " +
        "user gave us a real photograph of it, and a real product beats a " +
        "generated impression of one every time."
      : null,
    input.canRecordScreen
      ? "- `useScreenRecording: true` on a shot that shows the product's " +
        "INTERFACE. We record the real website, so the screen is genuinely " +
        "theirs — never approximate a UI in a generated frame."
      : null,
  ].filter(Boolean);

  const out = await chatJSON<{ styleAnchor?: string; shots?: RawShot[] }>(
    [
      {
        role: "system",
        content:
          "You are a director turning a voiceover into a shot list.\n" +
          'Return STRICT JSON: {"styleAnchor":"...","shots":[{"line":"...",' +
          '"visual":"...","direction":"...","useProductAsset":false,' +
          '"useScreenRecording":false}]}.\n' +
          `Return EXACTLY ${input.shotCount} shots.\n\n` +
          "`styleAnchor` describes what EVERY shot shares — the same one " +
          "person (age, build, hair, wardrobe), the same location, the same " +
          "light, the same lens and grade. One or two sentences. Every " +
          "keyframe is generated from it, so anything you leave out is " +
          "something that will change between shots.\n" +
          "`line` is the exact span of the script spoken over this shot. " +
          "Concatenated in order, the lines must reproduce the script " +
          "verbatim — do not paraphrase, add or drop words.\n" +
          "`visual` is ONE still frame: who is in it, what they are doing, how " +
          "it is framed. Describe only what a camera could see. No dialogue, " +
          "no scene numbers, no marketing claims.\n" +
          "`direction` is how this shot MOVES over about five seconds — one " +
          "camera or subject move. Achievable in the format's own idiom.\n" +
          "Never put a logo, wordmark, brand name, readable text or a screen " +
          "showing a brand in `visual`: the renderer is separately forbidden " +
          "from drawing those, and branding is composited afterwards.\n" +
          "Shots must ADVANCE: each one shows something the previous did not.",
      },
      {
        role: "user",
        content:
          `Format: ${spec.label} — ${spec.blurb}\n` +
          `Motion idiom: ${spec.motion}\n` +
          `Original concept: ${input.prompt}\n` +
          (brand ? `${brand}\n` : "") +
          `\nScript to cover, in ${input.shotCount} shots of ~${SEGMENT_SECONDS}s:\n` +
          input.script +
          (affordances.length ? `\n\nAvailable for specific shots:\n${affordances.join("\n")}` : ""),
      },
    ],
    { temperature: 0.6, maxTokens: 1600, timeoutMs: PLAN_TIMEOUT_MS, model: PLAN_MODEL },
  );

  return {
    styleAnchor: String(out?.styleAnchor ?? "").trim().slice(0, 600),
    shots: Array.isArray(out?.shots) ? out.shots : [],
  };
}

/**
 * Words a clip of this length can carry. Matches postproduce's own pace figure
 * so the plan and the narration are budgeting against the same number.
 */
const WORDS_PER_SECOND = 1.9;

/**
 * Build the whole plan. Never throws: a planning failure degrades to a
 * single-shot plan built from the prompt, which is exactly what the old
 * pipeline produced — so the worst case of adding this stage is the behaviour
 * that came before it.
 */
export async function buildPlan(input: {
  prompt: string;
  kind: VideoKind;
  shotCount: number;
  seconds: number;
  profile?: BrandProfile | null;
  tone?: ContentTone | null;
  hasProductAsset: boolean;
  canRecordScreen: boolean;
}): Promise<VideoPlan> {
  const words = Math.max(6, Math.round(input.seconds * WORDS_PER_SECOND));

  let candidates: Candidate[] = [];
  try {
    candidates = await writeCandidates({
      prompt: input.prompt,
      kind: input.kind,
      seconds: input.seconds,
      words,
      profile: input.profile,
      tone: input.tone,
    });
  } catch (err) {
    console.error("[video/plan] candidate scripts failed:", err);
  }

  if (candidates.length === 0) return fallbackPlan(input);

  let winner = 0;
  let critique = "";
  if (candidates.length > 1) {
    try {
      const chosen = await selectCandidate({
        candidates,
        prompt: input.prompt,
        kind: input.kind,
        seconds: input.seconds,
        profile: input.profile,
      });
      winner = chosen.index;
      critique = chosen.critique;
    } catch (err) {
      // Keeping the first candidate is a real answer, not a failure: it is a
      // complete on-brand script that simply was not compared to the others.
      console.error("[video/plan] critique failed, keeping first candidate:", err);
    }
  }
  const chosen = candidates[winner];

  let board: { styleAnchor: string; shots: RawShot[] } = { styleAnchor: "", shots: [] };
  try {
    board = await writeStoryboard({
      script: chosen.script,
      prompt: input.prompt,
      kind: input.kind,
      shotCount: input.shotCount,
      profile: input.profile,
      hasProductAsset: input.hasProductAsset,
      canRecordScreen: input.canRecordScreen,
    });
  } catch (err) {
    console.error("[video/plan] storyboard failed:", err);
  }

  const shots = normalizeShots({
    raw: board.shots,
    shotCount: input.shotCount,
    script: chosen.script,
    prompt: input.prompt,
    hasProductAsset: input.hasProductAsset,
    canRecordScreen: input.canRecordScreen,
  });

  return {
    script: chosen.script,
    cta: chosen.cta,
    critique: critique || `Kept "${chosen.angle || "first candidate"}".`,
    considered: candidates.length,
    styleAnchor: board.styleAnchor || defaultAnchor(input.prompt),
    shots,
  };
}

/**
 * Force the model's shot list into exactly the shape the renderer needs.
 *
 * Everything here is a correction the model is capable of getting wrong, and
 * each one has a consequence that is worse than the correction: too few shots
 * leaves takes with no direction, too many bills for renders nobody asked for,
 * and a `product_asset` shot when no asset exists is a keyframe step that
 * cannot run.
 */
function normalizeShots(input: {
  raw: RawShot[];
  shotCount: number;
  script: string;
  prompt: string;
  hasProductAsset: boolean;
  canRecordScreen: boolean;
}): Shot[] {
  const clean = (v: unknown, max: number) =>
    String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

  const usable = input.raw
    .map((s) => ({
      line: clean(s.line, 400),
      visual: clean(s.visual, 400),
      direction: clean(s.direction, 240),
      useProductAsset: !!s.useProductAsset,
      useScreenRecording: !!s.useScreenRecording,
    }))
    .filter((s) => s.visual);

  const shots: Shot[] = [];
  for (let i = 0; i < input.shotCount; i++) {
    // Wrapping rather than padding with a placeholder: if the model returned
    // four shots for six takes, repeating the coverage produces a clip that
    // reads as deliberate, where two empty shots would render as two frames of
    // nothing at all.
    const src = usable.length ? usable[i % usable.length] : null;
    let kind: ShotKind = "generated";
    if (src?.useScreenRecording && input.canRecordScreen) kind = "playwright_capture";
    else if (src?.useProductAsset && input.hasProductAsset) kind = "product_asset";

    shots.push({
      index: i,
      kind,
      line: src?.line ?? "",
      visual: src?.visual || input.prompt.slice(0, 300),
      direction: src?.direction ?? "",
      // The opening shot decides whether anyone watches the rest, and a shot
      // showing the product is the one a wrong render is least forgivable on.
      critical: i === 0 || kind === "product_asset",
    });
  }
  return shots;
}

function defaultAnchor(prompt: string): string {
  return `Consistent subject, location, wardrobe, lighting and colour grade across every shot. ${prompt.slice(0, 200)}`;
}

/**
 * What we produce when planning is unavailable — no OpenAI key, or every call
 * failed. One shot's worth of direction, repeated: the pre-plan behaviour.
 */
function fallbackPlan(input: {
  prompt: string;
  shotCount: number;
}): VideoPlan {
  return {
    script: "",
    cta: "",
    critique: "Planning unavailable — fell back to the prompt.",
    considered: 0,
    styleAnchor: defaultAnchor(input.prompt),
    shots: Array.from({ length: input.shotCount }, (_, i) => ({
      index: i,
      kind: "generated" as const,
      line: "",
      visual: input.prompt.slice(0, 300),
      direction: "",
      critical: i === 0,
    })),
  };
}
