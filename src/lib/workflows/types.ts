import type { WorkflowGroup } from "@/lib/data/workflows";

/**
 * Workflow engine types — TypeScript port of relay_poc's graph + run model.
 *
 * A workflow is a directed graph of typed steps executed by a single-cursor
 * interpreter (src/lib/workflows/engine.ts). The canonical graph lives in
 * `workflows.config` (jsonb); each run's journal lives in `workflow_runs.log`.
 */

export type StepType =
  | "manual_trigger_input"
  | "app_event_trigger"
  | "schedule_trigger"
  | "webhook_trigger"
  | "ai_step"
  | "meeting_summary"
  | "generate_image"
  | "generate_video"
  | "branch"
  | "filter"
  | "human_approval"
  | "app_action"
  | "social_post"
  | "log_action";

/**
 * One graph node. Routing keys live flat on the step (relay convention):
 * `next` for linear flow (null = terminal), `on_approve`/`on_reject` for
 * approvals, `on_fail` for a filter that doesn't pass, `branch_on` + `cases` +
 * `default` for conditional branches. Per-type config fields (instruction,
 * tool, arguments, platform, …) are also flat; `title`/`stage` are display
 * hints the engine ignores.
 */
export interface StepDef {
  type: StepType;
  next?: string | null;
  on_approve?: string | null;
  on_reject?: string | null;
  on_fail?: string | null;
  branch_on?: string;
  cases?: Record<string, string | null>;
  default?: string | null;
  title?: string;
  stage?: string;
  [key: string]: unknown;
}

export interface WorkflowGraph {
  start: string;
  steps: Record<string, StepDef>;
}

export interface WorkflowPosition { x: number; y: number }

export interface WorkflowEditorDraft {
  graph: WorkflowGraph;
  positions: Record<string, WorkflowPosition>;
  revision: number;
  updatedAt?: string;
  updatedBy?: string | null;
}

/** Stored in `workflows.config` (jsonb). */
export interface WorkflowConfig {
  v: 1;
  graph: WorkflowGraph;
  /** Pre-derived UI view-model — the pages render this verbatim. */
  display: { groups: WorkflowGroup[] };
  /** The natural-language prompt that built this workflow. */
  prompt?: string;
}

/**
 * Trigger bookkeeping: when the poller last looked, the newest record it had
 * already seen (app events), and when the workflow last actually fired
 * (schedules).
 *
 * Lives in its own `workflows.trigger_state` column, NOT in `config`.
 */
export interface TriggerState {
  lastCheckedAt?: string;
  cursor?: string;
  lastFiredAt?: string;
  /** Why the last poll produced nothing — unset target, app disconnected, provider error. */
  lastError?: string;
  /** Latest setup payload captured while a webhook workflow is paused. */
  sample?: {
    payload: Record<string, unknown>;
    fields: string[];
    receivedAt: string;
  };
  /**
   * How an app-event trigger is being delivered.
   */
  realtime?: {
    mode: "realtime" | "poll";
    instanceId?: string;
    slug?: string;
    reason?: string;
    channel?: "webhook" | "poll";
    at: string;
  };
}

/** One named value shown beside the content — a channel, a recipient, a subject. */
export interface PreviewField {
  label: string;
  value: string;
}

/**
 * One thing the run will do the moment the approval is granted, with the
 * content it will do it WITH — resolved, not templated.
 */
export interface PreviewAction {
  stepId: string;
  /** Short phrase in the imperative: "Publish to LinkedIn". */
  label: string;
  /** Toolkit / platform slug, so the card can draw the right logo. */
  app: string | null;
  /** The words that would go out, verbatim. */
  body?: string;
  /** The picture that would go out with them. */
  imageUrl?: string;
  /** The clip that would go out with them — a finished, archived MP4. */
  videoUrl?: string;
  /** Where it lands: subreddit, Slack channel, recipient, subject line. */
  fields: PreviewField[];
  unresolved?: boolean;
}

/** Something the run already produced and is holding — the draft under review. */
export interface PreviewDraft {
  stepId: string;
  title: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface PreviewGrounding {
  applied: boolean;
  brand?: string;
  kinds: ("copy" | "image" | "video")[];
}

export interface ApprovalPreview {
  summary: string;
  actions: PreviewAction[];
  drafts: PreviewDraft[];
  conditional?: boolean;
  onReject: string;
  grounding?: PreviewGrounding;
  simulated?: boolean;
}

/** One human's answer to one approval step. */
export interface RunDecision {
  decision: "approve" | "reject";
  note?: string;
  at: string;
}

/** Accumulated run state, available to every step. */
export interface RunContext {
  steps: Record<string, Record<string, unknown>>;
  last?: Record<string, unknown>;
  input?: Record<string, unknown>;
  decisions?: Record<string, RunDecision>;
}

export interface JournalEntry {
  stepId: string;
  type: StepType;
  title: string;
  status: "done";
  output: Record<string, unknown>;
  at: string;
}

export interface AwaitingState {
  kind: "video";
  stepId: string;
  ref: string;
  note: string;
  since: string;
}

/** Stored in `workflow_runs.log` (jsonb). */
export interface RunLog {
  v: 1;
  journal: JournalEntry[];
  context: RunContext;
  pending?: { token: string; stepId: string; prompt: string; preview?: ApprovalPreview };
  awaiting?: AwaitingState;
  error?: string;
  failed?: { stepId: string; message: string };
  attempts?: number;
}

export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed";

export interface RunResult {
  runId: string;
  status: RunStatus;
  error?: string;
}
