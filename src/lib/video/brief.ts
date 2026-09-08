import { chatJSON, openaiConfigured } from "@/lib/ai/openai";

/**
 * Reduce a video request to the one scene an image model can actually draw.
 *
 * The keyframe generator renders a SINGLE still, and every take animates from
 * it. But `prompt` is not always a scene: when an agent drives a goal it is a
 * whole shooting script, and one real request sent ~1,600 characters made of a
 * KPI preamble ("The number to move is 100 signups"), four bracketed scenes
 * ([INTRO – Founder on Camera]), emoji and hashtags. There is no single frame
 * that is four scenes and a KPI, so the model was being asked an impossible
 * question and answering it with mush.
 *
 * Short, already-visual prompts — what someone types in the Video Generator —
 * pass through untouched and cost nothing. Only scripted or oversized input
 * pays for a distillation pass.
 */

/** Longer than this and even clean prose is more than one frame's worth. */
const PASSTHROUGH_LIMIT = 400;

/** Room for the two sentences a scene is allowed to be. */
const SCENE_LIMIT = 480;

/**
 * Trim to `max` without cutting mid-word. Prefers the last sentence end, falls
 * back to the last space — a scene that stops at "...and advanced technology,
 * with" reads as corrupted input to the model, which is worse than a shorter
 * scene.
 */
function trimClean(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (sentence > max * 0.5) return cut.slice(0, sentence + 1).trim();
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

/** Bracketed stage directions, scene headers, markdown headings. */
const SCRIPTED = /\[[^\]]{2,60}\]|^\s*#{1,3}\s|\bSCENE\s*\d|\bINTRO\b|\bOUTRO\b|\bVOICEOVER\b/im;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

/** Does this read as a script rather than a scene? */
export function needsDistilling(raw: string): boolean {
  const t = (raw ?? "").trim();
  if (!t) return false;
  return t.length > PASSTHROUGH_LIMIT || SCRIPTED.test(t) || EMOJI.test(t);
}

/**
 * Strip the things that are definitely not a scene. Used as the fallback when
 * the model is unavailable or fails — a mechanically cleaned prompt is still
 * far better input than a script, and this must never throw.
 */
export function stripScriptFurniture(raw: string): string {
  const stripped = (raw ?? "")
    .replace(/\[[^\]]{2,60}\]/g, " ") // [INTRO – Founder on Camera]
    .replace(/^\s*#{1,3}\s+/gm, " ") // markdown headings
    .replace(/#[\p{L}\p{N}_]+/gu, " ") // #hashtags
    .replace(EMOJI, " ")
    .replace(/\s+/g, " ")
    .trim();
  return trimClean(stripped, PASSTHROUGH_LIMIT);
}

/**
 * The scene to render, given whatever the caller supplied.
 *
 * Never throws and never returns empty: every failure path degrades to the
 * mechanical strip, because a worse keyframe is a far better outcome than a
 * failed generation.
 */
export async function visualBrief(raw: string): Promise<string> {
  const text = (raw ?? "").trim();
  if (!text) return "";
  if (!needsDistilling(text)) return text;

  const fallback = stripScriptFurniture(text) || trimClean(text, PASSTHROUGH_LIMIT);
  if (!openaiConfigured) return fallback;

  try {
    const out = await chatJSON<{ scene?: string }>(
      [
        {
          role: "system",
          content:
            "You turn a marketing video request into ONE photographable scene. " +
            "Return strict JSON: {\"scene\": \"...\"}. " +
            "The scene is a single still frame: who is in it, where they are, " +
            "what the light is doing, how it is framed. " +
            "Describe only what a camera could see. " +
            "Never include dialogue, narration, scripts, scene numbers, shot " +
            "lists, hashtags, emoji, marketing claims, metrics or goals — those " +
            "are handled elsewhere in the pipeline. " +
            "Put NO logo, wordmark, brand name, screen showing a brand, or any " +
            "readable text in the scene: the renderer is separately forbidden " +
            "from drawing those, so describing one only sets up a contradiction. " +
            "One or two sentences, under 300 characters.",
        },
        { role: "user", content: text.slice(0, 4000) },
      ],
      { temperature: 0.2, maxTokens: 200 },
    );
    const scene = (out?.scene ?? "").trim();
    return scene ? trimClean(scene, SCENE_LIMIT) : fallback;
  } catch {
    return fallback;
  }
}
