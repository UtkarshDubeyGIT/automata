import { platformMeta } from "@/lib/social/platforms";
import { describeStep, stepApp } from "./blocks";
import { getEdge } from "./graph";
import { appLabel, getTool } from "./registry";
import { interpolate } from "./interpolate";
import type {
  ApprovalPreview,
  PreviewAction,
  PreviewDraft,
  PreviewField,
  PreviewGrounding,
  RunContext,
  RunLog,
  StepDef,
  WorkflowGraph,
} from "./types";

/**
 * "What am I approving?" — answered with the thing itself.
 *
 * A `human_approval` step used to reach the screen as its own prompt and
 * nothing else, so every approval in the product read "Approve this before it
 * goes out?" over two buttons. The post it was about was already fully
 * written: `social_post.text` is resolved from the run context, the picture is
 * a URL in the journal, and the account it lands on is on the step. All of it
 * sat one hop away from the card that asked.
 *
 * So this walks forward from the approval to the steps it unblocks, resolves
 * their templates against the run's OWN context, and returns the content —
 * the words, the image, the destination. Pure and I/O-free: it is called from
 * the engine at the moment a run suspends, and again on read for runs that
 * were already waiting before it existed.
 *
 * Pure by dependency now, not only by discipline: `interpolate` moved to
 * `interpolate.ts`, so this no longer reaches through `steps.ts` and drags the
 * OpenAI, Composio, Supabase and image clients along behind it. The UI still
 * consumes the RESULT — `ApprovalPreview` lives in types.ts, which is
 * client-safe, so a card imports the type alone.
 */

/** Enough to understand the decision; past this it is a run log, not a preview. */
const MAX_ACTIONS = 4;
const MAX_HOPS = 12;
const MAX_FIELDS = 6;
const MAX_BODY_CHARS = 2_000;
const MAX_FIELD_CHARS = 140;
const MAX_DRAFTS = 2;

/** Step types that DO something a person would want to see before saying yes. */
const ACTING = new Set(["social_post", "app_action", "log_action"]);

/** Steps that MAKE something — what the run is holding when it stops. */
const DRAFTING = new Set(["ai_step", "generate_image", "generate_video"]);

/** Steps whose route depends on data, so nothing past them can be promised. */
const CONDITIONAL = new Set(["branch", "filter"]);

/**
 * Argument/option keys that carry the message itself rather than describe it.
 * Ordered: the first one present wins, so an email's `body` beats its
 * `subject` for the big preview and the subject stays a field beside it.
 */
const BODY_KEYS = [
  "body",
  "message",
  "text",
  "content",
  "comment",
  "message_body",
  "html_body",
  "description",
  "reply",
];

const IMAGE_KEYS = ["image_url", "imageurl", "media_url", "mediaurl", "photo_url", "picture"];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)(\?|#|$)/i;

const VIDEO_EXT = /\.(mp4|mov|webm|m4v)(\?|#|$)/i;

export function buildApprovalPreview(
  graph: WorkflowGraph | null | undefined,
  stepId: string,
  log: RunLog | null | undefined,
): ApprovalPreview | undefined {
  const approval = graph?.steps?.[stepId];
  if (!graph || !approval) return undefined;

  const context: RunContext = log?.context ?? { steps: {} };
  const { actions, conditional } = walkForward(graph, approval, context);
  const drafts = draftsFrom(log);
  const grounding = groundingOf(log);

  return {
    summary: summarize(actions, conditional, Boolean(getEdge(approval, "on_approve"))),
    actions,
    drafts,
    ...(conditional ? { conditional: true } : {}),
    onReject: rejectLine(graph, approval),
    ...(grounding ? { grounding } : {}),
    ...(simulated(log) ? { simulated: true } : {}),
  };
}

/**
 * The preview for a waiting run, for the two endpoints that serve one.
 *
 * Prefers the snapshot the engine took when the run stopped, and derives one
 * from the workflow's current graph when there isn't one — every run that was
 * already waiting when this shipped has no snapshot, and telling those people
 * to re-run an automation to find out what it wants to publish is not an
 * upgrade. Never throws: an approval card missing its preview still approves.
 */
export function pendingPreview(
  log: RunLog | null | undefined,
  graph: WorkflowGraph | null | undefined,
): ApprovalPreview | null {
  const pending = log?.pending;
  if (!pending) return null;
  if (pending.preview) return pending.preview;
  try {
    return buildApprovalPreview(graph, pending.stepId, log) ?? null;
  } catch (err) {
    console.error("[workflows] could not describe a waiting approval:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Walking forward from the decision
// ---------------------------------------------------------------------------

function walkForward(
  graph: WorkflowGraph,
  approval: StepDef,
  context: RunContext,
): { actions: PreviewAction[]; conditional: boolean } {
  const actions: PreviewAction[] = [];
  let conditional = false;

  let cursor = getEdge(approval, "on_approve");
  const seen = new Set<string>();
  let hops = 0;

  while (cursor && !seen.has(cursor) && hops++ < MAX_HOPS && actions.length < MAX_ACTIONS) {
    seen.add(cursor);
    const step = graph.steps[cursor];
    if (!step) break;

    // A second approval is somebody else's decision, not part of this one.
    if (step.type === "human_approval") break;

    if (CONDITIONAL.has(step.type)) {
      // Which way it goes is decided by data this run has not produced yet, so
      // promising what follows would be a guess. Say that it depends instead.
      conditional = true;
      break;
    }

    const action = describeAction(cursor, step, context);
    if (action) actions.push(action);
    cursor = getEdge(step, "next");
  }

  return { actions, conditional };
}

function describeAction(
  stepId: string,
  step: StepDef,
  context: RunContext,
): PreviewAction | null {
  if (!ACTING.has(step.type)) return null;
  if (step.type === "social_post") return socialAction(stepId, step, context);
  if (step.type === "app_action") return appAction(stepId, step, context);
  return noteAction(stepId, step, context);
}

function socialAction(stepId: string, step: StepDef, context: RunContext): PreviewAction {
  const platform = str(step.platform);
  const channel = platformMeta(platform)?.name || appLabel(platform) || "a channel";
  const text = resolve(str(step.text), context);
  const media = resolve(str(step.mediaUrl), context);
  const gallery = resolve(str(step.mediaUrls), context);
  const mediaKind = str(step.mediaKind);
  const options = (step.options as Record<string, unknown>) ?? {};

  const fields: PreviewField[] = [];
  const galleryUrls = gallery.text.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (galleryUrls.length > 1) fields.push({ label: "Gallery", value: `${galleryUrls.length} images` });
  for (const [key, raw] of Object.entries(options)) {
    const value = resolve(scalar(raw), context);
    if (value.text) fields.push({ label: prettyLabel(key), value: clip(value.text, MAX_FIELD_CHARS) });
    if (fields.length >= MAX_FIELDS) break;
  }
  const website = resolve(str(step.websiteUrl), context);
  if (website.text && fields.length < MAX_FIELDS) {
    fields.push({ label: "Website", value: clip(website.text, MAX_FIELD_CHARS) });
  }
  if (website.text && step.linkStyle && fields.length < MAX_FIELDS) {
    fields.push({ label: "Link treatment", value: str(step.linkStyle) });
  }
  const linkLabel = resolve(str(step.linkLabel), context);
  if (linkLabel.text && fields.length < MAX_FIELDS) {
    fields.push({ label: "Link wording", value: clip(linkLabel.text, MAX_FIELD_CHARS) });
  }

  return action({
    stepId,
    label: `Publish to ${channel}`,
    app: stepApp(step) ?? platform ?? null,
    body: text,
    image: galleryUrls.length > 1 ? resolve(galleryUrls[0], context) : media,
    mediaKind,
    fields,
  });
}

function appAction(stepId: string, step: StepDef, context: RunContext): PreviewAction {
  const tool = str(step.tool);
  const spec = getTool(tool, step.tool_spec);
  const args = (step.arguments as Record<string, unknown>) ?? {};

  // A read fetches; it neither sends nor changes anything, so it is named but
  // not dressed up as content awaiting consent.
  const label = spec
    ? `${spec.kind === "read" ? "Fetch from" : "Run in"} ${appLabel(spec.app)} — ${spec.desc}`
    : `Run ${tool || "an app action"}`;

  const entries = Object.entries(args);
  const bodyKey = entries.find(([key]) => BODY_KEYS.includes(key.toLowerCase()))?.[0];
  const body = bodyKey ? resolve(scalar(args[bodyKey]), context) : blank();

  let image = blank();
  const fields: PreviewField[] = [];
  for (const [key, raw] of entries) {
    if (key === bodyKey) continue;
    const value = resolve(scalar(raw), context);
    if (!value.text) continue;
    if (!image.text && looksLikeImage(key, value.text)) {
      image = value;
      continue;
    }
    if (fields.length < MAX_FIELDS) {
      fields.push({ label: prettyLabel(key), value: clip(value.text, MAX_FIELD_CHARS) });
    }
  }

  return action({
    stepId,
    label,
    app: spec?.app ?? null,
    body,
    image,
    fields,
  });
}

function noteAction(stepId: string, step: StepDef, context: RunContext): PreviewAction {
  return action({
    stepId,
    label: "Record a note",
    app: null,
    body: resolve(str(step.message), context),
    image: blank(),
    fields: [],
  });
}

function action(input: {
  stepId: string;
  label: string;
  app: string | null;
  body: Resolved;
  image: Resolved;
  mediaKind?: string;
  fields: PreviewField[];
}): PreviewAction {
  const out: PreviewAction = {
    stepId: input.stepId,
    label: input.label,
    app: input.app,
    fields: input.fields,
  };
  if (input.body.text) out.body = clip(input.body.text, MAX_BODY_CHARS);
  // Only a real URL is a picture. A half-resolved one would render as a broken
  // image, which reads as "the automation is broken" rather than "not written
  // yet" — the `unresolved` flag below is what says that, in words.
  if (input.image.text && !input.image.unresolved && /^https?:\/\//i.test(input.image.text)) {
    // A clip and a still are both "the media", and the card cannot play one in
    // an <img>. Told apart by extension, which is the same test the publisher
    // uses to decide between a Reel and a photo post — so what the preview
    // shows and what Instagram receives are decided by one rule.
    if (input.mediaKind === "video" || (!input.mediaKind && VIDEO_EXT.test(input.image.text))) {
      out.videoUrl = input.image.text;
    } else if (input.mediaKind !== "document") {
      out.imageUrl = input.image.text;
    }
  }
  if (input.body.unresolved || input.image.unresolved) out.unresolved = true;
  return out;
}

// ---------------------------------------------------------------------------
// What the run already made
// ---------------------------------------------------------------------------

/**
 * The content the run is holding, newest first.
 *
 * This is what makes an approval that sits in front of a branch — the common
 * "classify, then decide, then post to one of three places" shape — still
 * show the draft: the post-to-be may be unknowable, but the words the model
 * just wrote are right there in the journal.
 */
function draftsFrom(log: RunLog | null | undefined): PreviewDraft[] {
  const drafts: PreviewDraft[] = [];
  const journal = log?.journal ?? [];
  for (let i = journal.length - 1; i >= 0 && drafts.length < MAX_DRAFTS; i--) {
    const entry = journal[i];
    if (!DRAFTING.has(entry.type)) continue;
    const output = entry.output ?? {};
    const text = outputText(output);
    const url = typeof output.url === "string" ? output.url : "";
    if (!text && !url) continue;
    const isClip = entry.type === "generate_video" || VIDEO_EXT.test(url);
    drafts.push({
      stepId: entry.stepId,
      title: entry.title || entry.stepId,
      ...(text ? { text: clip(text, MAX_BODY_CHARS) } : {}),
      ...(url ? (isClip ? { videoUrl: url } : { imageUrl: url }) : {}),
    });
  }
  return drafts;
}

/** The readable payload of a step output, whichever mode the step ran in. */
function outputText(output: Record<string, unknown>): string {
  if (typeof output.text === "string" && output.text.trim()) return output.text.trim();
  const result = output.result;
  if (result && typeof result === "object") {
    const parts = Object.values(result as Record<string, unknown>)
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .map((v) => v.trim());
    if (parts.length) return parts.join("\n\n");
  }
  return "";
}

/**
 * Was this written for THIS business, or for nobody in particular?
 *
 * Read off the journal rather than re-derived, because the only honest source
 * is what the generating step actually had in its hands at the time: the
 * profile may have been saved since, or been unreadable for that one run, and
 * a card that says "grounded in your brand" because a profile exists NOW would
 * be describing a different draft than the one on screen.
 */
function groundingOf(log: RunLog | null | undefined): PreviewGrounding | null {
  const kinds = new Set<"copy" | "image" | "video">();
  let applied = false;
  let brand = "";
  for (const entry of log?.journal ?? []) {
    if (!DRAFTING.has(entry.type)) continue;
    const output = entry.output ?? {};
    if (output.grounded === undefined) continue; // journaled before this existed
    kinds.add(
      entry.type === "ai_step" ? "copy" : entry.type === "generate_image" ? "image" : "video",
    );
    if (output.grounded === true) applied = true;
    if (!brand && typeof output.brand === "string") brand = output.brand;
  }
  if (!kinds.size) return null;
  return { applied, ...(brand ? { brand } : {}), kinds: [...kinds] };
}

/**
 * Was any of this built from preview data? Same flag the engine's taint rule
 * sets — and the reason it matters here is that such a run cannot publish
 * anyway (`steps.ts` refuses), so approving it would be consent to a refusal.
 */
function simulated(log: RunLog | null | undefined): boolean {
  return (log?.journal ?? []).some((entry) => entry.output?.sim === true);
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

function summarize(actions: PreviewAction[], conditional: boolean, hasNext: boolean): string {
  if (!actions.length) {
    if (conditional) return "What happens next depends on the data this run is carrying.";
    return hasNext
      ? "Approving lets the rest of the run carry on."
      : "Approving finishes the run — nothing else is waiting on it.";
  }
  const phrases = actions.map((a) => lowerFirst(a.label));
  const list =
    phrases.length === 1
      ? phrases[0]
      : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
  return conditional
    ? `Approve and it will ${list} — then what follows depends on the data.`
    : `Approve and it will ${list}.`;
}

function rejectLine(graph: WorkflowGraph, approval: StepDef): string {
  const target = getEdge(approval, "on_reject");
  const step = target ? graph.steps[target] : undefined;
  if (!step) return "Reject and the run stops here. Nothing is sent.";
  const described = describeStep(step);
  return `Reject and it goes to “${described.title}” instead. Nothing above is sent.`;
}

// ---------------------------------------------------------------------------
// Resolving a step's config against the run's context
// ---------------------------------------------------------------------------

interface Resolved {
  text: string;
  /** A `{{steps.x.y}}` that no step has produced yet — it runs after this decision. */
  unresolved: boolean;
}

function blank(): Resolved {
  return { text: "", unresolved: false };
}

/**
 * Resolve a templated value the way the handler will.
 *
 * A leftover `{{steps.draft.result.text}}` is not a defect here — it is a step
 * that has not run yet, which is precisely the case where there is nothing to
 * preview. Showing the braces would look like a bug, so they are stripped and
 * the flag carries the fact instead.
 */
function resolve(template: string, context: RunContext): Resolved {
  if (!template) return blank();
  const filled = interpolate(template, context);
  if (!filled.includes("{{")) return { text: filled.trim(), unresolved: false };
  const stripped = filled.replace(/\{\{.*?\}\}/g, "…").trim();
  // A value that was ONLY a reference leaves nothing but the ellipsis behind,
  // and "…" presented as the post is worse than no preview at all — it looks
  // like the automation is about to publish a single character.
  const hasWords = stripped.replace(/[…\s]/g, "").length > 0;
  return { text: hasWords ? stripped : "", unresolved: true };
}

function looksLikeImage(key: string, value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  return (
    IMAGE_KEYS.includes(key.toLowerCase().replace(/[^a-z_]/g, "")) ||
    IMAGE_EXT.test(value) ||
    VIDEO_EXT.test(value)
  );
}

/** Only scalars are worth previewing; a nested object is configuration, not content. */
function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** `recipient_email` → "Recipient email". */
function prettyLabel(key: string): string {
  const words = key.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : key;
}

function lowerFirst(value: string): string {
  return value ? value.charAt(0).toLowerCase() + value.slice(1) : value;
}
