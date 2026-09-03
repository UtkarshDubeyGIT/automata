import type { IconName } from "@/components/ui/icon";

/**
 * Automations / Workflows — the shared view-model types the pages render
 * plus the step-tile palette. The graph engine's types live in
 * src/lib/workflows/types.ts; graph → this shape lives in
 * src/lib/workflows/display.ts.
 */

export type StepKind = "toggle" | "hil";
export type TileColor = "indigo" | "amber" | "tan" | "green" | "red" | "violet";
export type AgentKey =
  | "content"
  | "video"
  | "viral"
  | "scheduler"
  | "analytics"
  | "trends";

export interface WorkflowStep {
  icon: IconName;
  tile: TileColor;
  title: string;
  agent?: AgentKey;
  kind?: StepKind;
}

export interface WorkflowGroup {
  label: string;
  steps: WorkflowStep[];
}

export interface Workflow {
  id: string;
  name: string;
  desc: string;
  active: boolean;
  schedule: string;
  lastRun: string;
  runs: number;
  success: string;
  groups: WorkflowGroup[];
  /** How this workflow starts — drives the header strip on the editor. */
  trigger?: {
    kind: "event" | "schedule" | "webhook" | "manual";
    label: string;
    /** Toolkit slug, for an app-event trigger. */
    app?: string;
    /** Poll cadence, for an app-event trigger. */
    intervalMinutes?: number;
    /** Human cadence ("Every day at 09:00 UTC"), for a scheduled trigger. */
    cadence?: string;
    /** What an app-event trigger is watching ("vercel/next.js"), when it is set. */
    watching?: string;
    lastCheckedAt?: string;
    /** Why the last poll produced nothing — shown so a silent trigger can explain itself. */
    error?: string;
    /**
     * How events reach us: pushed by the provider the moment they happen, or
     * found by the poller on its next pass. The difference is minutes, so it
     * belongs on screen rather than only in the database.
     */
    delivery?: "realtime" | "poll";
    /**
     * When `delivery` is "realtime", how Composio actually delivers it.
     *
     * "webhook" is a provider push and genuinely instant. "poll" is Composio
     * polling the account every couple of minutes and forwarding — far faster
     * than our hourly sweep, but not instant, and Gmail and Google Calendar are
     * both of these. Undefined on automations enabled before this was recorded.
     */
    deliveryChannel?: "webhook" | "poll";
    /**
     * Why `delivery` is "poll" on a trigger that could have pushed.
     *
     * The enable path has always written this to `trigger_state` and nothing
     * has ever read it, so an automation that asked for real time and settled
     * for hourly polling — no webhook secret, a config key the trigger type
     * required, a toolkit with no matching event — looked identical to one that
     * never wanted real time at all.
     */
    deliveryReason?: string;
  };
}

/** A run of assistant "response" text; `b` marks emphasized (bold) segments. */
export interface ResponseSegment {
  t: string;
  b?: boolean;
}

/** Light-theme tile colors: [background, foreground] as CSS var references. */
const TILE: Record<TileColor, [string, string]> = {
  indigo: ["var(--brand-subtle)", "var(--color-indigo-600)"],
  amber: ["var(--warning-surface)", "var(--color-amber-600)"],
  tan: ["#F2E9DE", "#B45309"],
  green: ["var(--success-surface)", "var(--color-green-600)"],
  red: ["var(--danger-surface)", "var(--color-red-600)"],
  violet: ["var(--color-indigo-100)", "var(--color-indigo-500)"],
};

export function tileColors(tile: TileColor): { bg: string; fg: string } {
  const [bg, fg] = TILE[tile] ?? TILE.indigo;
  return { bg, fg };
}
