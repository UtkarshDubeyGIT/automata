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
  | "whatsapp_reminder"
  | "firecrawl"
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
  // There was a second schedule shape here — `{ kind, spec }` — that nothing
  // ever read or wrote. The graph's schedule_trigger step IS the schedule, and
  // a second place to put one is a second place for it to be wrong.
}

/**
 * Trigger bookkeeping: when the poller last looked, the newest record it had
 * already seen (app events), and when the workflow last actually fired
 * (schedules).
 *
 * Lives in its own `workflows.trigger_state` column, NOT in `config`. The sweep
 * wrote it back as `config: {...row.config, triggerState}`, a whole-object
 * read-modify-write that silently reverted a graph saved mid-sweep. Migration
 * 0018 carries the old values across and the key is gone from WorkflowConfig,
 * so there is no second copy left to disagree.
 */
export interface TriggerState {
  lastCheckedAt?: string;
  cursor?: string;
  lastFiredAt?: string;
  /** Why the last poll produced nothing — unset target, app disconnected, provider error. */
  lastError?: string;
  /** Latest setup payload captured while a webhook workflow is paused. */
  sample?: {
    secret: string;
    payload: Record<string, unknown>;
    fields: string[];
    receivedAt: string;
  };
  /**
   * How an app-event trigger is being delivered.
   *
   * "realtime" means Composio is watching the account and pushes the event the
   * moment it happens; the sweep then leaves the workflow alone, because a
   * poll and a push are two different idempotency keys for one event and would
   * fire it twice. "poll" is the fallback, and `reason` says why — an
   * automation quietly running an hour behind should be able to explain itself.
   */
  realtime?: {
    mode: "realtime" | "poll";
    instanceId?: string;
    slug?: string;
    reason?: string;
    /**
     * How Composio delivers it when `mode` is "realtime": a genuine provider
     * webhook, or Composio polling the account itself every couple of minutes
     * and forwarding. Both beat our hourly sweep by a wide margin, but only
     * the first is instant — and the header claimed "Runs in real time" for
     * both, which overstates Gmail and Google Calendar (their trigger types
     * are `poll`). Absent on rows written before this existed.
     */
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
  /**
   * The wording is produced by a step that runs AFTER this decision, so there
   * is nothing to show yet. Said plainly beats showing raw `{{steps.x.y}}`.
   */
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

/**
 * Whether what is being approved was written FOR this business.
 *
 * Every generating step already reads the workspace's brand profile, and
 * every one of them does it best-effort — an unreadable profile costs
 * specificity, it never fails a run. The consequence was invisible: two runs
 * of the same automation, one grounded and one generic, produced approval
 * cards that looked identical. The generating steps now record which of the
 * two happened, and this carries it to the person deciding.
 */
export interface PreviewGrounding {
  /** Did a brand profile actually reach the model that wrote this? */
  applied: boolean;
  /** Who it was written for, when we know — the company name. */
  brand?: string;
  /** Which generating steps this describes, for the card's wording. */
  kinds: ("copy" | "image" | "video")[];
}

/**
 * What the person is actually approving.
 *
 * An approval that shows only its own prompt ("Approve this before it goes
 * out?") asks for consent to something invisible: the post text, the picture
 * and the account it lands on all exist by then — in the next step's config
 * and in the run's own journal — and none of it reached the screen. This is
 * that content, assembled once (src/lib/workflows/preview.ts) so the
 * Automations card and the run list can never describe the same decision
 * differently.
 */
export interface ApprovalPreview {
  /** One plain line: what pressing Approve does. */
  summary: string;
  /** Everything that follows the approval, in execution order. */
  actions: PreviewAction[];
  /** What the run made before it stopped, when that is the thing being judged. */
  drafts: PreviewDraft[];
  /** A branch or filter sits in between, so what runs next depends on data. */
  conditional?: boolean;
  /** What rejecting does instead. */
  onReject: string;
  /** Was this written for THIS business, or generically? */
  grounding?: PreviewGrounding;
  /** Built from preview/simulated data — nothing real would be sent. */
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
  /** Persisted once at claim/start so delayed report steps keep the same slot. */
  runStartedAt?: string;
  last?: Record<string, unknown>;
  input?: Record<string, unknown>;
  /**
   * Decisions recorded against approval steps, by step id.
   *
   * Part of the CONTEXT rather than a side table, because that is what makes an
   * approval replayable: the journal survives a restart, so a decision made
   * days later replays through the same handler and continues from exactly
   * where the run stopped.
   */
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

/**
 * A run parked on work something else is doing.
 *
 * A video render or Firecrawl job can take minutes and is driven by another
 * process/provider entirely. Holding a claimed run open for that would block
 * a worker, so the run suspends exactly the way an approval does — journal
 * intact, replayable — and the cron worker wakes it when the named work is
 * ready.
 */
export interface AwaitingState {
  /** What kind of work is being polled by the unattended worker. */
  kind: "video" | "firecrawl";
  /** The step that is waiting, so replay knows where to resume. */
  stepId: string;
  /** The row or provider job being watched. */
  ref: string;
  /** Provider operation, needed to poll a Firecrawl job without restarting it. */
  operation?: "crawl" | "agent";
  /** One line for the runs list: "Rendering a 15s clip". */
  note: string;
  /** When the wait started, for the horizon that gives up on it. */
  since: string;
}

/**
 * The step the engine is executing right now.
 *
 * Journals only describe completed work. Keeping this separate makes a
 * long-running provider call visible to the canvas without pretending its
 * output already exists or making it replayable.
 */
export interface ActiveStep {
  stepId: string;
  type: StepType;
  title: string;
  startedAt: string;
}

/** Stored in `workflow_runs.log` (jsonb). */
export interface RunLog {
  v: 1;
  journal: JournalEntry[];
  context: RunContext;
  /**
   * Present while a run is suspended awaiting a human.
   *
   * `preview` is what that human is being asked about — captured HERE, at the
   * moment the run stopped, because that is the only moment at which the
   * content is both final and still matches the graph the run is replaying
   * against. A workflow edited while a run waits must not change what the
   * approval card claims was up for approval.
   */
  pending?: { token: string; stepId: string; prompt: string; preview?: ApprovalPreview };
  /**
   * Present while a run is suspended awaiting a MACHINE — today, a video
   * render.
   *
   * Deliberately not `pending`. Both stop a run in the same durable way, but
   * one is a decision nobody but this person can make and the other is a
   * render nobody has to do anything about, and merging them would put "one
   * thing is waiting on you" in front of somebody whose only correct action is
   * to wait. `ref` is the row the step is watching; the beat resumes the run
   * when that row lands.
   */
  awaiting?: AwaitingState;
  /** Present only while one step handler is actively being executed. */
  active?: ActiveStep;
  error?: string;
  /**
   * WHICH step stopped the run. `error` alone is a sentence; this is the data
   * the canvas replay needs to paint the failing step red. A failing step is
   * never journaled — it produced no output — so the journal cannot say.
   */
  failed?: { stepId: string; message: string };
  /**
   * How many times a beat has driven this run. Replay makes a resume cheap and
   * safe, but a step that hangs every time would otherwise be retried on every
   * beat forever — this is what lets the reclaim eventually give up.
   */
  attempts?: number;
}

/**
 * `queued` is a run that has been claimed and CHARGED but not yet driven — the
 * state an unattended trigger lands in before a cron beat picks it up. It is
 * neither a success nor a failure, and every reader has to say so: the status
 * CHECK, the open-run index, the runs list, updateWorkflowStats and the
 * webhook's response body.
 */
export type RunStatus = "queued" | "running" | "waiting" | "completed" | "failed";

export interface RunResult {
  runId: string;
  status: RunStatus;
  error?: string;
}
