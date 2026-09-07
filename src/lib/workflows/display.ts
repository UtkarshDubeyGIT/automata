import type {
  ResponseSegment,
  Workflow,
  WorkflowGroup,
  WorkflowStep,
} from "@/lib/data/workflows";
import { platformMeta } from "@/lib/social/platforms";
import { describeStep, isTriggerType, nodeSpec, scheduleLabel, stepApp } from "./blocks";
import { orderedStepIds } from "./graph";
import { getTool, getTrigger, missingWatch, watchValues } from "./registry";
import type { StepDef, TriggerState, WorkflowConfig, WorkflowGraph } from "./types";

/**
 * Graph → UI view-model. The Automations pages render `WorkflowGroup[]`
 * (icons, tiles, stage labels, pills) — this module derives that shape
 * deterministically from a workflow graph so the UI never changes.
 *
 * Per-step appearance comes from the block catalog (src/lib/workflows/blocks.ts)
 * so the compact list, the visual canvas, and the builder preview can never
 * disagree about what a step looks like.
 */

export { orderedStepIds };

// ---------------------------------------------------------------------------
// Per-step display mapping
// ---------------------------------------------------------------------------

function displayStep(id: string, step: StepDef): WorkflowStep {
  const described = describeStep(step);
  const view: WorkflowStep = {
    icon: described.icon,
    tile: described.tile,
    title: described.title || id,
  };
  if (isTriggerType(step.type)) view.kind = "toggle";
  if (step.type === "human_approval") view.kind = "hil";
  if (step.type === "social_post") view.agent = "scheduler";
  return view;
}

function defaultStage(step: StepDef): string {
  if (step.type === "app_action") {
    return getTool(String(step.tool ?? ""), step.tool_spec)?.kind === "read" ? "Fetch" : "Act";
  }
  return nodeSpec(step.type)?.stage ?? "Step";
}

/** Derive the UI's `groups` (stage → steps) from a graph, execution-ordered. */
export function deriveDisplay(graph: WorkflowGraph): WorkflowGroup[] {
  const groups: WorkflowGroup[] = [];
  for (const id of orderedStepIds(graph)) {
    const step = graph.steps[id];
    const stage =
      typeof step.stage === "string" && step.stage.trim() ? step.stage.trim() : defaultStage(step);
    const view = displayStep(id, step);
    const last = groups[groups.length - 1];
    if (last && last.label === stage) last.steps.push(view);
    else groups.push({ label: stage, steps: [view] });
  }
  return groups;
}

/**
 * Toolkit slug for the automation's "lead" integration — the first social
 * platform or app action in execution order. Drives the row/header logo.
 */
export function leadLogo(graph: WorkflowGraph): string | null {
  if (!graph?.start || !graph.steps) return null;
  for (const id of orderedStepIds(graph)) {
    const app = stepApp(graph.steps[id]);
    if (app) return app;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row → the UI's Workflow shape
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  schedule: string | null;
  config: WorkflowConfig;
  draft_config?: WorkflowConfig | null;
  draft_positions?: Record<string, { x: number; y: number }> | null;
  draft_revision?: number | null;
  draft_updated_by?: string | null;
  /** Own column since 0018 — see TriggerState for why it left `config`. */
  trigger_state: TriggerState | null;
  runs: number;
  success_rate: string | null;
  last_run_at: string | null;
  created_at: string;
  /** Maintained by a DB trigger, so "Recently edited" can sort by an edit time. */
  updated_at: string | null;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** Trigger metadata for the detail header ("Checks every N min"), if any. */
export function triggerInfo(
  config: WorkflowConfig,
  state?: TriggerState | null,
): Workflow["trigger"] | undefined {
  const graph = config?.graph;
  const start = graph?.steps?.[graph?.start ?? ""];
  if (!start || !isTriggerType(start.type)) return undefined;
  const title = typeof start.title === "string" && start.title ? start.title : "";
  const lastCheckedAt = state?.lastCheckedAt;
  const error = state?.lastError;

  switch (start.type) {
    case "app_event_trigger": {
      const spec = getTrigger(String(start.event ?? ""));
      if (!spec) return undefined;
      const interval = Number(start.interval_minutes);
      const watch = watchValues(start);
      // `state.lastError` is a string the background poller cached on its last
      // pass and can predate a since-saved fix — without this, a "Not set up
      // yet" reads as permanently broken until the next poll happens to run
      // (which may be up to `interval` minutes away, or never, if the poller
      // isn't scheduled in this environment). The live config is cheap to
      // check, so don't surface a config error the live config already fixed.
      const staleSetupError = error?.startsWith("Not set up yet") && missingWatch(start).length === 0;
      return {
        kind: "event",
        app: spec.app,
        label: title || spec.desc,
        delivery: state?.realtime?.mode === "realtime" ? "realtime" : "poll",
        deliveryChannel: state?.realtime?.channel,
        // Only when it actually fell back — a reason recorded while the
        // automation was paused ("The automation is paused.") is not a
        // limitation of the trigger, and re-enabling re-resolves it anyway.
        deliveryReason:
          state?.realtime?.mode === "poll" ? state.realtime.reason : undefined,
        intervalMinutes: Number.isFinite(interval) && interval > 0 ? interval : 60,
        watching:
          (spec.watch ?? [])
            .map((w) => watch[w.key])
            .filter(Boolean)
            .join("/") || undefined,
        lastCheckedAt,
        error: staleSetupError ? undefined : error,
      };
    }
    case "schedule_trigger":
      return {
        kind: "schedule",
        label: title || scheduleLabel(start),
        cadence: scheduleLabel(start),
        lastCheckedAt,
        error,
      };
    case "webhook_trigger":
      return { kind: "webhook", label: title || "Incoming webhook", lastCheckedAt, error };
    default:
      return { kind: "manual", label: title || "Run manually" };
  }
}

/**
 * The one-line cadence stored in `workflows.schedule` and shown on the list —
 * derived from the trigger so the column can never drift from the graph.
 */
export function scheduleText(config: WorkflowConfig, state?: TriggerState | null): string {
  // `state` is optional because all three callers write this into
  // `workflows.schedule` at SAVE time, when the automation has not been
  // switched on and no trigger state exists yet — so in practice this reports
  // the polling cadence and the real-time branch below is only reached if a
  // caller passes state. Worth keeping honest rather than deleting: the column
  // is a snapshot taken at save, so a workflow later upgraded to a real-time
  // watch keeps whatever this said until it is next saved, and the editor
  // header (which reads `trigger_state` through `toWorkflowView`) is the
  // surface that always tells the truth.
  const trigger = triggerInfo(config, state);
  if (!trigger) return "Manual";
  switch (trigger.kind) {
    case "event":
      // Only a provider push is instant. A Composio-side poll still beats our
      // sweep by a wide margin, but calling it "real time" overstated Gmail and
      // Google Calendar, whose trigger types are `poll`. An automation enabled
      // before the channel was recorded has none, and keeps the old wording.
      if (trigger.delivery === "realtime") {
        return trigger.deliveryChannel === "poll" ? "Checks every few minutes" : "Runs in real time";
      }
      return (trigger.intervalMinutes ?? 60) >= 60
        ? "Checks hourly"
        : `Checks every ${trigger.intervalMinutes} min`;
    case "schedule":
      return trigger.cadence ?? "Scheduled";
    case "webhook":
      return "On webhook";
    default:
      return "Manual";
  }
}

/** Map a DB row to the exact shape the Automations pages render. */
export function toWorkflowView(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    name: row.name,
    desc: row.description ?? "",
    active: row.active,
    schedule: row.schedule ?? "Manual",
    lastRun: relTime(row.last_run_at),
    runs: row.runs,
    success: row.success_rate ?? "—",
    groups: row.config?.display?.groups ?? deriveDisplay(row.config.graph),
    trigger: triggerInfo(row.config, row.trigger_state),
  };
}

// ---------------------------------------------------------------------------
// Builder dialog response paragraphs (deterministic, from the graph)
// ---------------------------------------------------------------------------

export function buildResponse(name: string, graph: WorkflowGraph): ResponseSegment[][] {
  const steps = orderedStepIds(graph).map((id) => graph.steps[id]);

  const reads = steps
    .filter((s) => s.type === "app_action" && getTool(String(s.tool), s.tool_spec)?.kind === "read")
    .map((s) => getTool(String(s.tool), s.tool_spec)!.app);
  const writes = steps
    .filter((s) => s.type === "app_action" && getTool(String(s.tool), s.tool_spec)?.kind === "write")
    .map((s) => getTool(String(s.tool), s.tool_spec)!.app);
  const posts = steps
    .filter((s) => s.type === "social_post")
    .map((s) => platformMeta(String(s.platform))?.name ?? String(s.platform));
  const hasAI = steps.some((s) => s.type === "ai_step" || s.type === "meeting_summary");
  const hasReview = steps.some((s) => s.type === "human_approval");

  const trigger = steps.find((s) => s.type === "app_event_trigger");
  const triggerSpec = trigger ? getTrigger(String(trigger.event ?? "")) : undefined;

  const middle: ResponseSegment[] = [{ t: "It " }];
  const parts: ResponseSegment[][] = [];
  if (triggerSpec) {
    parts.push([
      { t: "fires on " },
      { t: String(trigger?.title ?? "each app event").toLowerCase(), b: true },
    ]);
  }
  if (reads.length) {
    parts.push([{ t: "pulls data from " }, { t: dedupe(reads).join(" & "), b: true }]);
  }
  if (hasAI) {
    parts.push([{ t: "has " }, { t: "Claude", b: true }, { t: " do the drafting" }]);
  }
  if (hasReview) {
    parts.push([{ t: "waits for " }, { t: "your review", b: true }]);
  }
  if (posts.length) {
    parts.push([{ t: "then posts to " }, { t: dedupe(posts).join(" & "), b: true }]);
  }
  if (writes.length) {
    parts.push([{ t: "then acts in " }, { t: dedupe(writes).join(" & "), b: true }]);
  }
  if (!parts.length) {
    parts.push([{ t: "runs each step in order" }]);
  }
  parts.forEach((p, i) => {
    if (i > 0) middle.push({ t: ", " });
    middle.push(...p);
  });
  middle.push({ t: "." });

  return [
    [{ t: "I'll set up " }, { t: name, b: true }, { t: "." }],
    middle,
    [{ t: "Switch it on whenever you’re ready — tweak any step anytime." }],
  ];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
