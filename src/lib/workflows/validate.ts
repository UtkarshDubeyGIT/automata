import { PLATFORMS } from "@/lib/social/platforms";
import {
  isTriggerType,
  MAX_EVERY_DAYS,
  MAX_EVERY_HOURS,
  nodeSpec,
  outputKeys,
  outputPathsOf,
} from "./blocks";
import {
  ancestors,
  configEntries,
  findCycle,
  hasTerminal,
  orphanIds,
  outEdges,
  refPathsIn,
  refsIn,
} from "./graph";
import {
  appLabel,
  getTool,
  getTrigger,
  isPlaceholder,
  missingWatch,
  SIMULATED_APPS,
  TOOLS,
} from "./registry";
import { repairRefs } from "./repair";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * Graph validation — the single gate every graph passes through, whether it
 * came from the AI compiler, the visual editor, or a template. Pure (no LLM,
 * no I/O) so the editor can lint as you type and the save route can re-check
 * the same rules server-side before anything is persisted.
 */

export class BuildError extends Error {}

/** The engine's step budget is 50; a graph bigger than this cannot finish. */
const MAX_STEPS = 60;
const MAX_GRAPH_BYTES = 256 * 1024;

const SOCIAL_PLATFORMS = new Set(
  PLATFORMS.filter((p) => p.id !== "youtube" && p.id !== "tiktok").map((p) => p.id as string),
);

export const FILTER_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "gt",
  "lt",
  "is_empty",
  "not_empty",
]);

/** Full structural + dataflow validation. Throws BuildError on the first problem. */
export function validateGraph(graph: WorkflowGraph): void {
  if (!graph?.start) throw new BuildError("missing top-level key 'start'");
  const steps = graph.steps;
  if (!steps || typeof steps !== "object" || !Object.keys(steps).length) {
    throw new BuildError("'steps' must be a non-empty object");
  }
  // Bounds, because a graph is attacker-supplied jsonb on the save path and
  // every check below walks it. The engine's own step budget is 50, so a graph
  // larger than this could not run to completion anyway.
  if (Object.keys(steps).length > MAX_STEPS) {
    throw new BuildError(`a workflow can have at most ${MAX_STEPS} steps`);
  }
  let size: number;
  try {
    size = JSON.stringify(graph).length;
  } catch {
    throw new BuildError("that workflow isn't serializable");
  }
  if (size > MAX_GRAPH_BYTES) {
    throw new BuildError(`that workflow is too large (${Math.round(size / 1024)}KB)`);
  }
  if (!steps[graph.start]) throw new BuildError(`start node '${graph.start}' not in steps`);
  if (!isTriggerType(steps[graph.start].type)) {
    throw new BuildError("the first step must be a trigger — add one at the top of the workflow");
  }

  const validIds = new Set(Object.keys(steps));
  for (const [nodeId, node] of Object.entries(steps)) {
    if (!nodeSpec(node.type)) {
      throw new BuildError(`node '${nodeId}' uses unknown type '${node.type}'`);
    }
    if (isTriggerType(node.type) && nodeId !== graph.start) {
      throw new BuildError(
        `'${title(node, nodeId)}' is a trigger but isn't the first step — a workflow has exactly one trigger`,
      );
    }
    validateConfig(nodeId, node);
    validateApprovalEdges(nodeId, node);

    if (node.cases && node.default === undefined) {
      throw new BuildError(`node '${nodeId}' has 'cases' but no 'default' route`);
    }
    for (const ref of outEdges(node)) {
      if (!validIds.has(ref)) {
        throw new BuildError(`node '${nodeId}' routes to missing node '${ref}'`);
      }
    }
  }

  // Reject the loop at build time rather than discovering it mid-run, when the
  // step budget stops it only AFTER the steps have already run for real.
  const cycle = findCycle(graph);
  if (cycle) {
    throw new BuildError(
      `these steps loop forever: ${cycle.map((id) => `'${title(steps[id] ?? ({} as StepDef), id)}'`).join(" -> ")}. ` +
        `Remove the connection that goes back, or end that path instead.`,
    );
  }
  if (!hasTerminal(graph)) {
    throw new BuildError("workflow has no terminal path (possible infinite loop)");
  }
  validateTemplates(graph);
  validateDataflow(graph);
  validateRefFields(graph);
  validateAiHasSource(graph);
}

function title(node: StepDef, fallback: string): string {
  return typeof node.title === "string" && node.title.trim() ? node.title.trim() : fallback;
}

/**
 * Per-type identity config: values the engine could never interpret because
 * they name something that doesn't exist. Blank-but-fillable fields are NOT
 * checked here — those are "needs setup" (see `missingSetup`), so a
 * half-built workflow can still be saved, exactly like Relay.
 */
function validateConfig(nodeId: string, node: StepDef): void {
  const name = title(node, nodeId);
  switch (node.type) {
    case "app_event_trigger": {
      const event = String(node.event ?? "");
      if (event && !getTrigger(event)) {
        throw new BuildError(
          `node '${nodeId}' uses unknown trigger '${event}'. Use one of the exact slugs from AVAILABLE TRIGGERS.`,
        );
      }
      break;
    }
    case "schedule_trigger": {
      const cadence = String(node.cadence ?? "daily");
      if (!["hourly", "daily", "weekly"].includes(cadence)) {
        throw new BuildError(`'${name}': schedule must repeat hourly, daily, or weekly`);
      }

      // The interval is what makes "alternate days" and "once every three
      // days" sayable at all. Rejecting a wrong one LOUDLY is the whole point:
      // the failure this replaces was the compiler having no way to express
      // the request and quietly settling for "every day" — three times too
      // often, with nothing said to anyone.
      if (node.every !== undefined) {
        const every = Number(node.every);
        const max = cadence === "hourly" ? MAX_EVERY_HOURS : MAX_EVERY_DAYS;
        if (!Number.isInteger(every) || every < 1 || every > max) {
          throw new BuildError(
            `'${name}': repeat every must be a whole number from 1 to ${max}`,
          );
        }
        if (cadence === "weekly" && every > 1) {
          throw new BuildError(
            `'${name}': a weekly schedule names its days in 'weekdays' — for a longer gap ` +
              `use cadence "daily" with a bigger 'every' (every other Monday is every 14 days).`,
          );
        }
      }

      if (node.weekdays !== undefined) {
        if (cadence !== "weekly") {
          throw new BuildError(
            `'${name}': 'weekdays' only applies to cadence "weekly" — set cadence to ` +
              `"weekly" to run on chosen days.`,
          );
        }
        const days = node.weekdays;
        if (!Array.isArray(days) || days.length === 0) {
          throw new BuildError(`'${name}': choose at least one day of the week`);
        }
        if (days.some((d) => !Number.isInteger(d) || (d as number) < 0 || (d as number) > 6)) {
          throw new BuildError(
            `'${name}': days of the week are 0 (Sunday) to 6 (Saturday)`,
          );
        }
      }

      if (node.start !== undefined) {
        const start = node.start;
        if (
          typeof start !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
          Number.isNaN(Date.parse(start))
        ) {
          throw new BuildError(`'${name}': the start date must look like 2026-03-01`);
        }
      }
      break;
    }
    case "generate_image": {
      const aspect = String(node.aspect ?? "square");
      if (!["vertical", "square", "landscape"].includes(aspect)) {
        throw new BuildError(`'${name}': shape must be vertical, square, or landscape`);
      }
      break;
    }
    case "generate_video": {
      const kind = String(node.kind ?? "shortform");
      if (!["shortform", "ugc", "cinematic"].includes(kind)) {
        throw new BuildError(`'${name}': video style must be shortform, ugc, or cinematic`);
      }
      const ratio = String(node.aspectRatio ?? "9:16");
      if (!["9:16", "4:5", "1:1", "16:9"].includes(ratio)) {
        throw new BuildError(`'${name}': video shape must be 9:16, 4:5, 1:1, or 16:9`);
      }
      if (node.durationSec !== undefined) {
        const secs = Number(node.durationSec);
        if (!Number.isFinite(secs) || secs < 5 || secs > 60) {
          throw new BuildError(`'${name}': clip length must be between 5 and 60 seconds`);
        }
      }
      break;
    }
    case "app_action": {
      const slug = String(node.tool ?? "");
      if (slug && !(slug in TOOLS)) {
        throw new BuildError(
          `node '${nodeId}' uses unknown app action '${slug}'. Use one of the exact tool slugs from AVAILABLE APP ACTIONS.`,
        );
      }
      break;
    }
    case "social_post": {
      const platform = String(node.platform ?? "");
      if (platform && !SOCIAL_PLATFORMS.has(platform)) {
        throw new BuildError(
          `node '${nodeId}' posts to unsupported platform '${platform}'. Use one of: ${[...SOCIAL_PLATFORMS].join(", ")}.`,
        );
      }
      const mediaKind = String(node.mediaKind ?? "auto");
      if (!["", "auto", "image", "video", "document"].includes(mediaKind)) {
        throw new BuildError(
          `'${name}': LinkedIn media must be auto, image, video, or document`,
        );
      }
      const linkStyle = String(node.linkStyle ?? "soft");
      if (!["", "none", "soft", "direct"].includes(linkStyle)) {
        throw new BuildError(`'${name}': link treatment must be none, soft, or direct`);
      }
      break;
    }
    case "filter": {
      const op = String(node.operator ?? "");
      if (op && !FILTER_OPERATORS.has(op)) {
        throw new BuildError(`'${name}': '${op}' is not a supported condition`);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * An approve/reject route only means something on a step that emits a
 * `decision` — and `human_approval` is the only type that does (`outputKeys`).
 *
 * The engine's approval branch fires on a wired `on_approve`/`on_reject`
 * whatever the step type is, so one of these on, say, an `ai_step` reads an
 * undefined decision and takes `on_reject` on EVERY run. The failure is
 * entirely silent: the step never suspends, so no run reaches `waiting`, the
 * sidebar badge stays empty and the detail page never shows the review banner
 * — the human-in-the-loop the author asked for simply never happens, and the
 * whole workflow quietly runs down its reject path instead. Worse in the
 * inverse shape, where `on_reject` points at the publish and it goes out with
 * no approval ever requested.
 *
 * Caught here because this is the one gate all three authors pass: the AI
 * builder gets re-asked with this message (`MAX_REPAIRS`), and the editor
 * lints it before save. The visual editor cannot produce it — `insertOnEdge`
 * only writes these keys when the spec's `routing` declares them — so the
 * reachable source is a model that ignored builder.ts rule 7.
 *
 * Only a WIRED edge is rejected. A leftover `on_approve: null` is inert for
 * routing, and failing on it would strand an already-saved graph: the canvas
 * can null an edge but has no way to delete the key, so the error would be
 * unfixable from the UI it points the user at.
 */
function validateApprovalEdges(nodeId: string, node: StepDef): void {
  if (nodeSpec(node.type)?.routing.includes("on_approve")) return;
  for (const slot of ["on_approve", "on_reject"] as const) {
    const target = node[slot];
    if (typeof target !== "string" || !target) continue;
    throw new BuildError(
      `'${title(node, nodeId)}' is a '${node.type}' step but routes '${slot}' — only an ` +
        `'Ask a human' (human_approval) step can be approved or rejected, so nobody would ever ` +
        `be asked and every run would take the reject path. Add a human_approval step before ` +
        `this one and move the approve/reject routes onto it.`,
    );
  }
}

/**
 * Fields a step still needs before it can actually run. Returned per step so
 * the editor can badge the card "Needs setup" and the detail page can refuse
 * to switch the automation on.
 */
export function missingSetup(step: StepDef): string[] {
  const missing: string[] = [];
  // Not just empty — UNUSABLE. A value the builder copied out of an example
  // (`"<org>"`, `"a@b.com"`) reads as filled in to a blank test, which is how a
  // GitHub trigger went live pointing at a repository called `<repo>`. Every
  // field checked in here is a config target, so a stand-in is worth exactly as
  // much as an empty box: nothing.
  const blank = (v: unknown) =>
    v === undefined || v === null || String(v).trim() === "" || isPlaceholder(v);

  switch (step.type) {
    case "app_event_trigger":
      if (blank(step.event)) {
        missing.push("Choose which event starts this workflow");
        break;
      }
      // The poller can't ask which repo or channel to watch at 3am, so an
      // unanswered setting blocks switching the automation on rather than
      // becoming a silent 404 on every sweep.
      for (const w of missingWatch(step)) missing.push(`Fill in “${w.label}”`);
      break;
    case "ai_step":
      if (blank(step.instruction)) missing.push("Tell the AI what to do");
      break;
    case "meeting_summary":
      if (blank(step.transcript_field)) missing.push("Name the webhook transcript field");
      break;
    case "generate_image":
      if (blank(step.prompt)) missing.push("Describe the image to generate");
      break;
    case "generate_video":
      if (blank(step.prompt)) missing.push("Describe the video to generate");
      break;
    case "branch": {
      if (blank(step.key ?? step.branch_on)) missing.push("Choose which key to branch on");
      if (blank(step.from_step)) missing.push("Choose which step the value comes from");
      break;
    }
    case "filter":
      if (blank(step.source)) missing.push("Choose a value to check");
      break;
    case "app_action": {
      const slug = String(step.tool ?? "");
      if (!slug) {
        missing.push("Choose an action");
        break;
      }
      const args = (step.arguments as Record<string, unknown>) ?? {};
      for (const req of TOOLS[slug]?.required ?? []) {
        if (blank(args[req])) missing.push(`Fill in “${req}”`);
      }
      break;
    }
    case "social_post": {
      if (blank(step.platform)) missing.push("Choose a channel");
      if (blank(step.text) && blank(step.instruction)) {
        missing.push("Write the post text (or reference an AI step)");
      }
      if (
        String(step.platform) === "linkedin" &&
        !["", "auto"].includes(String(step.mediaKind ?? "auto")) &&
        blank(step.mediaUrl) &&
        blank(step.mediaUrls)
      ) {
        missing.push("Add the image, video, or PDF URL to publish");
      }
      if (String(step.platform) === "instagram" && blank(step.mediaUrl)) {
        // Answerable from inside the graph now: add a "Generate an image" step
        // and point this at its url. Before that block existed the only fix was
        // to paste a link from somewhere else entirely.
        missing.push("Instagram posts need an image — add one and use its URL here");
      }
      if (String(step.platform) === "reddit") {
        const options = (step.options as Record<string, unknown>) ?? {};
        if (blank(options.subreddit)) missing.push("Reddit posts need a subreddit");
        if (blank(options.title)) missing.push("Reddit posts need a title");
      }
      if (String(step.platform) === "slack") {
        const options = (step.options as Record<string, unknown>) ?? {};
        if (blank(options.channel) && blank(options.dmUser) && blank(options.dm_user)) {
          missing.push("Slack posts need a channel or DM member ID");
        }
      }
      break;
    }
    default:
      break;
  }
  return missing;
}

/**
 * How many STEPS still need setup — not how many things are wrong with them.
 *
 * Both callers used to count the flattened messages, so one GitHub trigger
 * missing owner and repo reported "2 steps still need setup" for a single card.
 */
export function gapCount(gaps: Record<string, string[]>): number {
  return Object.keys(gaps).length;
}

/** Steps that still need setup, keyed by step id. Empty = ready to run. */
export function setupGaps(graph: WorkflowGraph): Record<string, string[]> {
  const gaps: Record<string, string[]> = {};
  for (const [id, step] of Object.entries(graph.steps)) {
    const missing = missingSetup(step);
    if (missing.length) gaps[id] = missing;
  }
  return gaps;
}

/**
 * The steps in this graph that reach a real, connected account and cannot be
 * taken back — a publish, a send, a record written at a provider.
 *
 * Used by the Run button, and only by it. Run has no real event to work from,
 * so an `app_event_trigger` is handed the trigger's canned SAMPLE event
 * (steps.ts) — but nothing downstream is sampled: the AI writes a real reply to
 * the invented review and `social_post`/`app_action` publish it for real. The
 * engine's simulation-taint rule deliberately does not cover this (a sample
 * event is not `sim`), and it shouldn't: refusing would make an event-triggered
 * automation impossible to try end to end. So the honest place to handle it is
 * the button — name the irreversible steps and let the person decide.
 *
 * A read is not listed: it changes nothing. Neither is an app with no Composio
 * toolkit, which always runs simulated whatever the account looks like.
 */
export function liveWrites(graph: WorkflowGraph): string[] {
  const out: string[] = [];
  for (const [id, step] of Object.entries(graph.steps)) {
    const title = typeof step.title === "string" && step.title.trim() ? step.title.trim() : id;
    if (step.type === "social_post") {
      out.push(`${title} — posts to ${appLabel(String(step.platform ?? "the channel"))}`);
      continue;
    }
    if (step.type !== "app_action") continue;
    const spec = getTool(String(step.tool ?? ""));
    if (!spec || spec.kind === "read" || SIMULATED_APPS.has(spec.app)) continue;
    out.push(`${title} — ${spec.desc} (${appLabel(spec.app)})`);
  }
  return out;
}

const TEMPLATE_RE = /\{\{([\s\S]*?)\}\}/g;
const SIMPLE_PATH_RE = /^\s*steps\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+\s*$/;

/**
 * Every {{...}} must be a plain dotted path — the engine has no expression
 * evaluator, so ternaries/fallbacks would reach the provider unresolved.
 */
function validateTemplates(graph: WorkflowGraph): void {
  const walk = (nodeId: string, value: unknown): void => {
    if (typeof value === "string") {
      for (const m of value.matchAll(TEMPLATE_RE)) {
        if (!SIMPLE_PATH_RE.test(m[1])) {
          throw new BuildError(
            `node '${nodeId}' uses '{{${m[1].trim().slice(0, 80)}}}' — templates must be a simple ` +
              `{{steps.<id>.<field>}} path with NO expressions or ternaries. If branches produce ` +
              `different data, give each branch its own action step instead of one shared step.`,
          );
        }
      }
    } else if (Array.isArray(value)) {
      for (const v of value) walk(nodeId, v);
    } else if (value && typeof value === "object") {
      for (const v of Object.values(value)) walk(nodeId, v);
    }
  };
  for (const [nodeId, node] of Object.entries(graph.steps)) {
    for (const [, v] of configEntries(node)) walk(nodeId, v);
  }
}

/** Every {{steps.X.Y}} reference must come from an ancestor node. */
function validateDataflow(graph: WorkflowGraph): void {
  for (const [nodeId, node] of Object.entries(graph.steps)) {
    const refs = new Set<string>();
    for (const [, v] of configEntries(node)) {
      for (const r of refsIn(v)) refs.add(r);
    }
    if (!refs.size) continue;
    const anc = ancestors(graph, nodeId);
    for (const refId of refs) {
      if (!(refId in graph.steps)) {
        throw new BuildError(
          `node '${nodeId}' references data from '${refId}', which is not a step in the workflow`,
        );
      }
      if (refId === nodeId) throw new BuildError(`node '${nodeId}' references its own output`);
      if (!anc.has(refId)) {
        throw new BuildError(
          `node '${nodeId}' references '{{steps.${refId}...}}' but '${refId}' does not run before it — data would be empty. Reorder so '${refId}' is upstream of '${nodeId}'.`,
        );
      }
    }
  }
}

/**
 * Every {{steps.X.Y}} must name a field step X can actually produce.
 *
 * `validateDataflow` proves the data arrives in time; this proves it exists at
 * all. Without it the classic mistake — pointing at `.result` on a text-mode
 * ai_step, which emits `.text` — validates clean, saves clean, and then dies on
 * the first run when the engine hands the literal "{{steps.draft.result}}" to
 * LinkedIn. Wrong-but-plausible references are the single largest source of
 * "it built fine and then failed", so they are a build-time error.
 */
function validateRefFields(graph: WorkflowGraph): void {
  for (const [nodeId, node] of Object.entries(graph.steps)) {
    for (const [, v] of configEntries(node)) {
      for (const ref of refPathsIn(v)) {
        const source = graph.steps[ref.stepId];
        if (!source) continue; // already reported by validateDataflow
        const keys = outputKeys(source);
        const field = ref.path.split(".")[0];
        if (!keys.size || keys.has(field)) continue;

        const offered = outputPathsOf(source);
        const suggestion = offered.length
          ? ` Use ${offered.map((p) => `{{steps.${ref.stepId}.${p}}}`).join(" or ")}.`
          : "";
        throw new BuildError(
          `node '${nodeId}' references '{{steps.${ref.stepId}.${ref.path}}}', but ` +
            `'${title(source, ref.stepId)}' never produces '${field}'.${suggestion}`,
        );
      }
    }
  }
}

const READ_TOOL_HINTS = ["FETCH", "GET", "RETRIEVE", "READ", "QUERY", "SEARCH", "LIST"];
const EXTERNAL_SOURCE_PHRASES = [
  "notion page",
  "notion",
  "the document",
  "the doc",
  "the article",
  "the file",
  "the web page",
  "the webpage",
  "the wiki",
  "existing page",
  "the page's",
  "contents of the page",
  "my orders",
  "my products",
  "my issues",
  "my sheet",
  "the spreadsheet",
];

function isReadStep(node: StepDef | undefined): boolean {
  if (!node || node.type !== "app_action") return false;
  const tool = String(node.tool ?? "").toUpperCase();
  return READ_TOOL_HINTS.some((h) => tool.includes(h));
}

/** An ai_step that consumes external app content must have an upstream READ. */
function validateAiHasSource(graph: WorkflowGraph): void {
  for (const [nodeId, node] of Object.entries(graph.steps)) {
    if (node.type !== "ai_step") continue;
    const instruction = String(node.instruction ?? "").toLowerCase();
    if (refsIn(node.instruction).size) continue; // already grounded upstream
    if (!EXTERNAL_SOURCE_PHRASES.some((p) => instruction.includes(p))) continue;
    const anc = ancestors(graph, nodeId);
    if (![...anc].some((a) => isReadStep(graph.steps[a]))) {
      throw new BuildError(
        `ai_step '${nodeId}' references external stored content ("${instruction.slice(0, 60)}...") but no upstream step READS it. Add an app_action read step before '${nodeId}' and reference its output as {{steps.<read>.text}}.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Non-fatal lint — what the visual editor shows while you work
// ---------------------------------------------------------------------------

export interface LintIssue {
  /** The step the problem belongs to, when it can be attributed to one. */
  stepId?: string;
  message: string;
  /** error blocks saving · setup blocks running · warning is advisory. */
  severity: "error" | "setup" | "warning";
}

/**
 * Editor-facing checks. Errors are exactly what `validateGraph` would reject
 * (so Save is never a surprise); "setup" issues are blank required fields that
 * block running; warnings are advisory — unreachable steps, empty branches.
 */
export function lintGraph(graph: WorkflowGraph): LintIssue[] {
  const issues: LintIssue[] = [];

  try {
    // Lint what SAVING would judge: the save route repairs recoverable
    // references first, so linting the raw graph would flag a problem the user
    // never has — and "Save is never a surprise" is the point of this function.
    validateGraph(repairRefs(graph).graph);
  } catch (err) {
    issues.push({ message: (err as Error).message, severity: "error", stepId: blameStep(graph, err) });
  }

  for (const [id, missing] of Object.entries(setupGaps(graph))) {
    for (const message of missing) {
      issues.push({ stepId: id, severity: "setup", message });
    }
  }

  for (const id of orphanIds(graph)) {
    issues.push({
      stepId: id,
      severity: "warning",
      message: `“${title(graph.steps[id], id)}” isn't connected to anything — it will never run.`,
    });
  }

  for (const [id, step] of Object.entries(graph.steps)) {
    if (step.type === "branch") {
      const cases = (step.cases as Record<string, string | null>) ?? {};
      const empty = Object.entries(cases).filter(([, target]) => !target);
      if (empty.length) {
        issues.push({
          stepId: id,
          severity: "warning",
          message: `Path${empty.length > 1 ? "s" : ""} “${empty.map(([v]) => v).join("”, “")}” end${empty.length > 1 ? "" : "s"} immediately — add a step or remove the path.`,
        });
      }
    }
  }

  return issues;
}

/** Best-effort: which step a BuildError message is about, for inline display. */
function blameStep(graph: WorkflowGraph, err: unknown): string | undefined {
  const message = (err as Error)?.message ?? "";
  const byId = message.match(/node '([A-Za-z0-9_]+)'/);
  if (byId && graph.steps[byId[1]]) return byId[1];
  const byTitle = message.match(/^'([^']+)'/);
  if (byTitle) {
    const found = Object.entries(graph.steps).find(
      ([id, step]) => title(step, id) === byTitle[1],
    );
    if (found) return found[0];
  }
  return undefined;
}
