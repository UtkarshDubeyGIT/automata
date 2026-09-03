import type { IconName } from "@/components/ui/icon";
import type { TileColor } from "@/lib/data/workflows";
import { PLATFORMS, platformMeta } from "@/lib/social/platforms";
import { appLabel, getTool, getTrigger, SIMULATED_APPS, TOOLS, TRIGGERS, watchValues } from "./registry";
import type { StepDef, StepType } from "./types";

/**
 * The block catalog — ONE definition of what a workflow node is, consumed by
 * every surface:
 *
 *   • the AI builder  → `purpose` + `config` become the compiler's prompt
 *   • the visual editor → `fields` render the inspector, `palette()` renders
 *     the "add a step" picker, `outputsOf` powers the data-reference picker
 *   • validation      → the set of known types and their required config
 *   • the run/list UI → `icon`, `tile`, `stage`, `summary`
 *
 * Because all of them read this file, a workflow the AI writes is by
 * construction a workflow the visual editor can open, edit, and save back.
 *
 * Pure data — safe to import from client components.
 */

// ---------------------------------------------------------------------------
// Field specs (drive the inspector)
// ---------------------------------------------------------------------------

export type FieldKind =
  | "text"
  | "textarea"
  | "number"
  | "select"
  | "list"
  | "keyvalue"
  | "cases"
  // A whole schedule is one idea to a user but five keys on the step, so like
  // "cases" it is one bespoke control rather than a row of inputs that let you
  // pick a weekday for an hourly schedule.
  | "schedule";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  hint?: string;
  placeholder?: string;
  /** Static choices for a `select`. */
  choices?: { value: string; label: string; hint?: string }[];
  /** Choices the editor resolves at render time. */
  source?: "triggers" | "tools" | "platforms" | "steps";
  /** Value accepts {{steps.…}} references — the editor offers the data picker. */
  templated?: boolean;
  required?: boolean;
  /** Render only when a sibling field holds this value (or one of them). */
  showIf?: { key: string; equals: string | string[] };
  keyLabel?: string;
  valueLabel?: string;
}

export type RoutingKey =
  | "next"
  | "on_approve"
  | "on_reject"
  | "on_fail"
  | "branch_on"
  | "cases"
  | "default";

export interface NodeTypeSpec {
  type: StepType;
  label: string;
  icon: IconName;
  tile: TileColor;
  /** Default stage label (the grouping header in the compact step list). */
  stage: string;
  /** Only a trigger may be the start node, and only the start node may be one. */
  trigger?: boolean;
  /** Sentence the AI compiler sees. */
  purpose: string;
  /** Config keys the AI compiler may emit → what each means. */
  config: Record<string, string>;
  /**
   * What downstream steps may reference as {{steps.<id>.…}}, in the compiler's
   * words. Stating this in the prompt is what stops the model pointing at a
   * field the step never writes — a graph that validates but cannot run.
   */
  produces: string;
  routing: RoutingKey[];
  /** Inspector fields, in order. */
  fields: FieldSpec[];
  /** Config the editor writes when the user inserts a fresh block. */
  defaults?: Record<string, unknown>;
  /** One-line description under the card title in the visual editor. */
  summary?: (step: StepDef) => string;
  /** Paths downstream steps can reference as {{steps.<id>.<path>}}. */
  outputs?: (step: StepDef) => { path: string; label: string }[];
}

const TITLE_FIELDS: FieldSpec[] = [
  {
    key: "title",
    label: "Step name",
    kind: "text",
    placeholder: "Describe what this step does",
    hint: "Shown on the card. Verb-led reads best — “Draft the reply”.",
  },
  {
    key: "stage",
    label: "Stage",
    kind: "text",
    placeholder: "Trigger, Research, Draft, Publish…",
    hint: "Consecutive steps sharing a stage are grouped in summaries.",
  },
];

/**
 * Every trigger's watch settings as inspector fields, each shown only when its
 * own event is the one selected. Generated from the registry so adding a
 * trigger with a new setting needs no editor change.
 */
const WATCH_FIELDS: FieldSpec[] = Object.entries(TRIGGERS).flatMap(([slug, spec]) =>
  (spec.watch ?? []).map((w) => ({
    key: `watch_${w.key}`,
    label: w.label,
    kind: "text" as const,
    hint: w.hint,
    placeholder: w.placeholder,
    required: w.required,
    showIf: { key: "event", equals: slug },
  })),
);

/**
 * Trigger slugs with no real-time watch — the ONLY ones whose polling cadence
 * is a setting rather than an invisible fallback.
 *
 * Where `realtime` exists we subscribe, and polling is what happens silently if
 * that can't be arranged (see realtime.ts, which never fails the toggle). A
 * cadence box on those triggers offers a knob that does nothing on the path the
 * automation actually takes, and advertises the slower path as the plan.
 *
 * A simulated app is excluded for the opposite reason: the sweep only stamps
 * `lastCheckedAt` for those, so how fast it would poll is a setting for
 * something that never runs.
 *
 * Today that leaves this EMPTY, and the field never renders — every real
 * trigger asks Composio for a push. It stays derived rather than deleted so
 * that a trigger added tomorrow with nothing to subscribe to gets its cadence
 * control back without anyone remembering this rule.
 */
const POLL_ONLY_TRIGGERS = Object.entries(TRIGGERS)
  .filter(([, spec]) => !spec.realtime && !SIMULATED_APPS.has(spec.app))
  .map(([slug]) => slug);

function truncate(text: string, max = 90): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

/** 24-hour clock hour → "10:00 AM" / "12:00 PM" style label. */
function formatHour12(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? "AM" : "PM";
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  return `${displayHour}:00 ${period}`;
}

/** One choice per hour of the day, in plain 12-hour time — no "0-23" for users to translate. */
export const HOUR_CHOICES = Array.from({ length: 24 }, (_, hour) => ({
  value: String(hour),
  label: formatHour12(hour),
}));

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

export const NODE_TYPES: Record<StepType, NodeTypeSpec> = {
  // ---- triggers ----------------------------------------------------------
  manual_trigger_input: {
    type: "manual_trigger_input",
    produces:
      "input.<field> for each declared field (the values the run started with), and fields",
    label: "Run manually",
    icon: "mouse-pointer-click",
    tile: "indigo",
    stage: "Trigger",
    trigger: true,
    purpose:
      "The manual start of the workflow — the user runs it on demand. Use when no app event fits.",
    config: { fields: "list of input field names the user provides at run time" },
    routing: ["next"],
    defaults: { fields: [] },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "fields",
        label: "Input fields",
        kind: "list",
        hint: "Optional extras collected at run time. Steps read them as {{steps.<id>.input.<field>}}.",
        placeholder: "topic",
      },
    ],
    summary: (s) => {
      const fields = Array.isArray(s.fields) ? (s.fields as string[]) : [];
      return fields.length ? `Collects: ${fields.join(", ")}` : "Starts when you press Run";
    },
    outputs: (s) => {
      const fields = Array.isArray(s.fields) ? (s.fields as string[]) : [];
      return fields.map((f) => ({ path: `input.${f}`, label: f }));
    },
  },

  app_event_trigger: {
    type: "app_event_trigger",
    produces:
      "event.<field> for each field of the chosen event, plus app and trigger",
    label: "When something happens in an app",
    icon: "zap",
    tile: "indigo",
    stage: "Trigger",
    trigger: true,
    purpose:
      "The event start of the workflow — fires automatically when something happens in a connected " +
      "app (see AVAILABLE TRIGGERS). Use when the user says 'when/whenever X happens'. Later steps " +
      "read the event via {{steps.<trigger_id>.event.<field>}}.",
    config: {
      app: "the app slug of the trigger",
      event: "the exact trigger slug from AVAILABLE TRIGGERS",
      interval_minutes: "polling cadence in minutes (default 60)",
      "watch_<setting>":
        "what to watch, per the trigger's REQUIRED SETTINGS (e.g. watch_owner, watch_repo)",
    },
    routing: ["next"],
    defaults: { interval_minutes: 60 },
    fields: [
      ...TITLE_FIELDS,
      { key: "event", label: "Event", kind: "select", source: "triggers", required: true },
      // One field per watch setting across every trigger, revealed by the event
      // that owns it — so choosing "New GitHub issue" asks for owner and repo,
      // and choosing a Slack message asks for the channel instead.
      ...WATCH_FIELDS,
      {
        key: "interval_minutes",
        label: "Check every (minutes)",
        kind: "number",
        hint: "How often the poller looks for new items.",
        showIf: { key: "event", equals: POLL_ONLY_TRIGGERS },
      },
    ],
    summary: (s) => {
      const spec = getTrigger(str(s.event));
      if (!spec) return "Pick an event";
      // Naming the target is the difference between "watches GitHub" and
      // "watches vercel/next.js" — the latter is what the user set up.
      const watch = watchValues(s);
      const target = (spec.watch ?? [])
        .map((w) => watch[w.key])
        .filter(Boolean)
        .join("/");
      const head = `${spec.desc}${target ? ` · ${target}` : ""}`;
      // A cadence belongs on the card only where it is the plan rather than the
      // silent fallback — the same rule, and the same set, as the hidden field
      // above. Anything else advertises the slower path on a trigger that
      // doesn't take it.
      if (!POLL_ONLY_TRIGGERS.includes(str(s.event))) return head;
      const every = Number(s.interval_minutes) || 60;
      return `${head} · checks ${every >= 60 ? "hourly" : `every ${every} min`}`;
    },
    outputs: (s) => {
      const spec = getTrigger(str(s.event));
      if (!spec) return [];
      return Object.entries(spec.event).map(([k, v]) => ({ path: `event.${k}`, label: `${k} — ${v}` }));
    },
  },

  schedule_trigger: {
    type: "schedule_trigger",
    produces:
      "firedAt (ISO timestamp of this run) and cadence",
    label: "On a schedule",
    icon: "calendar-clock",
    tile: "indigo",
    stage: "Trigger",
    trigger: true,
    purpose:
      "The scheduled start of the workflow — fires on a recurring routine with no user action. " +
      "Use when the user names any repeating routine: 'every day', 'every Monday', " +
      "'every Monday, Saturday and Sunday', 'alternate days', 'once every 3 days', " +
      "'every 6 hours', 'hourly'.",
    config: {
      cadence: "'hourly' | 'daily' | 'weekly' — which unit the routine repeats in",
      every:
        "how many of that unit between runs; 1 means every one. 'daily' with every 2 is " +
        "alternate days, 'daily' with every 3 is once every three days, 'hourly' with " +
        "every 6 is every six hours. Max 30 for daily, 23 for hourly. 'weekly' ignores it.",
      weekdays:
        "'weekly' ONLY: the days it runs on as an array, 0=Sunday … 6=Saturday. " +
        "[1,6,0] is Monday, Saturday and Sunday. Never empty.",
      hour: "hour of day 0-23 (daily and weekly; ignored for hourly)",
      start:
        "'daily' with every > 1 ONLY: 'YYYY-MM-DD' the count runs from, so 'alternate " +
        "days' knows which days. Omit and it counts from a fixed reference date.",
    },
    routing: ["next"],
    defaults: { cadence: "daily", every: 1, hour: 9 },
    fields: [
      ...TITLE_FIELDS,
      // One control, not five: see FieldKind above.
      { key: "cadence", label: "Repeats", kind: "schedule", required: true },
    ],
    summary: (s) => scheduleLabel(s),
    outputs: () => [{ path: "firedAt", label: "firedAt — ISO timestamp of this run" }],
  },

  webhook_trigger: {
    type: "webhook_trigger",
    produces:
      "the incoming JSON under trigger; later fields use {{trigger.<path>}}",
    label: "Incoming Webhook",
    icon: "webhook",
    tile: "indigo",
    stage: "Trigger",
    trigger: true,
    purpose:
      "The inbound start of the workflow — fires when an external system POSTs JSON to this " +
      "workflow's unique webhook URL. The posted body is available as {{trigger.<field>}}.",
    config: { secret: "secure token embedded in the webhook URL" },
    routing: ["next"],
    fields: [
      ...TITLE_FIELDS,
      {
        key: "sample_fields",
        label: "Available payload fields",
        kind: "list",
        hint: "Captured automatically from the latest test event. Nested paths are supported.",
        placeholder: "email",
      },
    ],
    summary: () => "Fires when JSON is POSTed to the workflow's webhook URL",
    outputs: (s) => {
      const fields = Array.isArray(s.sample_fields) ? (s.sample_fields as string[]) : [];
      return [
        { path: "body", label: "body — the whole JSON payload" },
        ...fields.map((f) => ({ path: `body.${f}`, label: f })),
      ];
    },
  },

  // ---- work --------------------------------------------------------------
  ai_step: {
    type: "ai_step",
    produces:
      "WHEN output=text: ONLY text — reference it as {{steps.<id>.text}}. WHEN output=json: " +
      "ONLY result and result.<schema key> — reference {{steps.<id>.result.<key>}}. NEVER " +
      "reference .result on a text step or .text on a json step; the run fails.",
    label: "Do it with AI",
    icon: "claude",
    tile: "tan",
    stage: "Process",
    purpose: "Do one AI task: extract, classify, summarize, write, score, etc.",
    config: {
      instruction: "what the AI should do (reference upstream data via {{steps.<id>.field}})",
      output: "'text' or 'json'",
      schema: "if output=json: object mapping key -> short description",
    },
    routing: ["next", "branch_on", "cases", "default"],
    defaults: { instruction: "", output: "text" },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "instruction",
        label: "Instruction",
        kind: "textarea",
        required: true,
        templated: true,
        placeholder: "Write a short, warm reply to this review: {{steps.trigger.event.text}}",
        hint:
          "Your business profile is added automatically. For anything from this run, insert it " +
          "with the data picker — the AI sees no other data from an earlier step.",
      },
      {
        key: "output",
        label: "Output",
        kind: "select",
        choices: [
          { value: "text", label: "Plain text", hint: "Read it as {{steps.<id>.text}}" },
          { value: "json", label: "Structured JSON", hint: "Read keys as {{steps.<id>.result.<key>}}" },
        ],
      },
      {
        key: "schema",
        label: "JSON keys",
        kind: "keyvalue",
        showIf: { key: "output", equals: "json" },
        keyLabel: "key",
        valueLabel: "what it should contain",
        hint: "The AI is forced to return exactly these keys.",
      },
    ],
    summary: (s) => truncate(str(s.instruction) || "No instruction yet"),
    outputs: (s) => {
      if (s.output === "json") {
        const schema = (s.schema as Record<string, string>) ?? {};
        const keys = Object.keys(schema);
        return keys.length
          ? keys.map((k) => ({ path: `result.${k}`, label: `${k} — ${schema[k]}` }))
          : [{ path: "result", label: "result — the whole JSON object" }];
      }
      return [{ path: "text", label: "text — the generated text" }];
    },
  },

  meeting_summary: {
    type: "meeting_summary",
    produces:
      "text (the complete Slack-ready meeting summary), meetingId, provider, model and chunks",
    label: "Summarize a meeting",
    icon: "sparkles",
    tile: "tan",
    stage: "Process",
    purpose:
      "Summarize a complete meeting transcript received by a webhook. This node reads the original " +
      "webhook payload so long transcripts are chunked instead of truncated. Use it for events such " +
      "as meeting.transcription.completed, then publish {{steps.<id>.text}} to Slack.",
    config: {
      transcript_field: "top-level webhook body field containing the transcript; defaults to transcript",
    },
    routing: ["next"],
    defaults: { transcript_field: "transcript" },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "transcript_field",
        label: "Transcript field",
        kind: "text",
        required: true,
        placeholder: "transcript",
        hint: "The top-level field meet.doubtbuddy.com sends in the webhook body.",
      },
    ],
    summary: (s) => `Summarizes webhook field “${str(s.transcript_field) || "transcript"}”`,
    outputs: () => [
      { path: "text", label: "text — Slack-ready structured meeting summary" },
      { path: "meetingId", label: "meetingId — source meeting identifier" },
    ],
  },

  generate_image: {
    type: "generate_image",
    produces:
      "ONLY url (a public link to the generated image) and provider — reference it as " +
      "{{steps.<id>.url}}. There is no text output.",
    label: "Generate an image",
    icon: "image",
    tile: "tan",
    stage: "Process",
    purpose:
      "Generate an on-brand image and publish it. Use this whenever a post needs a picture — " +
      "an instagram social_post REQUIRES one, since Instagram will not accept a text-only post. " +
      "The workspace's brand palette, typography and uploaded product photos are applied " +
      "automatically; describe only the subject.",
    config: {
      prompt: "what the image should show (may reference {{steps.<id>.field}})",
      aspect: "'vertical', 'square' or 'landscape'",
    },
    routing: ["next"],
    defaults: { prompt: "", aspect: "square" },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "prompt",
        label: "What to picture",
        kind: "textarea",
        required: true,
        templated: true,
        placeholder: "The product on a clean desk, morning light, no text",
        hint:
          "Your brand colors, fonts and product images are added automatically — describe the " +
          "subject, not the styling.",
      },
      {
        key: "aspect",
        label: "Shape",
        kind: "select",
        choices: [
          { value: "square", label: "Square", hint: "Instagram feed, LinkedIn" },
          { value: "vertical", label: "Vertical", hint: "Stories, Reels" },
          { value: "landscape", label: "Landscape", hint: "X, blog headers" },
        ],
      },
      {
        key: "useAssets",
        label: "Build on my product images",
        kind: "select",
        choices: [
          { value: "yes", label: "Yes — use my uploaded assets" },
          { value: "no", label: "No — generate from the description alone" },
        ],
        hint: "Uploaded product photos keep the real product the hero of the picture.",
      },
    ],
    summary: (s) => truncate(str(s.prompt) || "No description yet"),
    outputs: () => [{ path: "url", label: "url — public link to the image" }],
  },

  /**
   * The clip an automation films for itself.
   *
   * Deliberately no `useAssets`, no keyframe upload and no product URL: those
   * are choices a person makes while watching a preview, and this step runs at
   * 3am. What it does take is the two things that change what the clip IS —
   * what it shows and how long it runs — and the brand does the rest, frozen
   * onto the row at queue time so a rescan mid-render cannot rebrand it.
   *
   * The choices below are spelled out rather than imported from the video
   * module: this file is in the client bundle (canvas, inspector, step
   * picker), and reaching into `lib/video` from here would drag the provider
   * chain in with it — the trap documented in lib/workflows/AGENTS.md.
   */
  generate_video: {
    type: "generate_video",
    produces:
      "ONLY url (a public link to the finished mp4), thumbnailUrl and durationSec — reference " +
      "it as {{steps.<id>.url}}. There is no text output.",
    label: "Generate a video",
    icon: "video",
    tile: "tan",
    stage: "Process",
    purpose:
      "Film a short branded clip and publish it. Use this when the post should be a video — " +
      "an instagram social_post carrying {{steps.<id>.url}} publishes as a Reel. The clip is " +
      "rendered by the video pipeline, which takes several minutes: the run PAUSES at this " +
      "step and resumes on its own when the clip lands, so put it before the approval and the " +
      "publish, never after them. The workspace's brand is applied automatically.",
    config: {
      prompt: "what the video should show (may reference {{steps.<id>.field}})",
      kind: "'shortform', 'ugc' or 'cinematic'",
      aspectRatio: "'9:16', '1:1', '4:5' or '16:9'",
      durationSec: "clip length in seconds, 5-60 — rounded to whole takes",
    },
    routing: ["next"],
    defaults: { prompt: "", kind: "shortform", aspectRatio: "9:16", durationSec: 10 },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "prompt",
        label: "What to film",
        kind: "textarea",
        required: true,
        templated: true,
        placeholder: "The product on a desk while someone explains what it does",
        hint:
          "Your brand — palette, typography, product context — is applied automatically. " +
          "Describe the subject, not the styling.",
      },
      {
        key: "kind",
        label: "Style",
        kind: "select",
        choices: [
          { value: "shortform", label: "Short-form", hint: "Punchy, built to stop the scroll" },
          { value: "ugc", label: "UGC ad", hint: "Handheld, a real person to camera" },
          { value: "cinematic", label: "Cinematic", hint: "Premium, graded, slow camera moves" },
        ],
      },
      {
        key: "aspectRatio",
        label: "Shape",
        kind: "select",
        choices: [
          { value: "9:16", label: "Vertical", hint: "Reels, Stories, TikTok" },
          { value: "4:5", label: "Portrait", hint: "Instagram feed" },
          { value: "1:1", label: "Square", hint: "Feed, LinkedIn" },
          { value: "16:9", label: "Landscape", hint: "YouTube, X, embeds" },
        ],
      },
      {
        key: "durationSec",
        label: "Length",
        kind: "select",
        choices: [
          { value: "5", label: "5 seconds" },
          { value: "10", label: "10 seconds" },
          { value: "15", label: "15 seconds" },
          { value: "20", label: "20 seconds" },
          { value: "30", label: "30 seconds" },
        ],
        hint: "Clips are built from whole ~5.4s takes, so a length lands on the nearest one. Longer costs more.",
      },
    ],
    summary: (s) => truncate(str(s.prompt) || "No description yet"),
    outputs: () => [
      { path: "url", label: "url — public link to the video" },
      { path: "thumbnailUrl", label: "thumbnailUrl — poster frame" },
    ],
  },

  branch: {
    type: "branch",
    produces:
      "the branched-on key itself (e.g. {{steps.<id>.<key>}}) and branched_on",
    label: "Split into paths",
    icon: "git-branch",
    tile: "amber",
    stage: "Route",
    purpose: "Route to different steps based on a value from a prior json ai_step.",
    config: { from_step: "id of upstream ai_step", key: "key in its result to branch on" },
    routing: ["branch_on", "cases", "default"],
    defaults: { key: "category" },
    fields: [
      ...TITLE_FIELDS,
      { key: "from_step", label: "Read the value from", kind: "select", source: "steps", required: true },
      {
        key: "key",
        label: "Key to branch on",
        kind: "text",
        required: true,
        placeholder: "category",
        hint: "A key in that step's JSON result.",
      },
      { key: "cases", label: "Paths", kind: "cases" },
    ],
    summary: (s) => {
      const cases = Object.keys((s.cases as Record<string, string>) ?? {});
      const key = str(s.key) || "value";
      return cases.length ? `On ${key}: ${cases.join(" / ")} (+ fallback)` : `On ${key} — no paths yet`;
    },
    outputs: (s) => [{ path: str(s.key) || "value", label: "the value that was branched on" }],
  },

  filter: {
    type: "filter",
    produces:
      "passed (true when the condition held) and value (the resolved value tested)",
    label: "Only continue if…",
    icon: "funnel",
    tile: "amber",
    stage: "Filter",
    purpose:
      "Stop the run unless a condition holds. Use for 'only if', 'skip when', 'ignore unless'. " +
      "Compares a {{steps.…}} value against a target; when it fails the run ends cleanly.",
    config: {
      source: "a {{steps.<id>.<field>}} reference (or literal) to test",
      operator: "'contains' | 'not_contains' | 'equals' | 'not_equals' | 'gt' | 'lt' | 'is_empty' | 'not_empty'",
      value: "what to compare against (omit for is_empty / not_empty)",
    },
    routing: ["next", "on_fail"],
    defaults: { source: "", operator: "not_empty", value: "" },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "source",
        label: "Check this value",
        kind: "text",
        required: true,
        templated: true,
        placeholder: "{{steps.classify.result.category}}",
      },
      {
        key: "operator",
        label: "Condition",
        kind: "select",
        required: true,
        choices: [
          { value: "equals", label: "is exactly" },
          { value: "not_equals", label: "is not" },
          { value: "contains", label: "contains" },
          { value: "not_contains", label: "does not contain" },
          { value: "gt", label: "is greater than" },
          { value: "lt", label: "is less than" },
          { value: "not_empty", label: "is not empty" },
          { value: "is_empty", label: "is empty" },
        ],
      },
      {
        key: "value",
        label: "Compared to",
        kind: "text",
        templated: true,
        placeholder: "negative",
      },
    ],
    summary: (s) => {
      const op = str(s.operator) || "not_empty";
      const label =
        NODE_TYPES.filter.fields.find((f) => f.key === "operator")?.choices?.find((c) => c.value === op)
          ?.label ?? op;
      const needsValue = op !== "is_empty" && op !== "not_empty";
      return `${truncate(str(s.source) || "(nothing)", 40)} ${label}${needsValue ? ` ${truncate(str(s.value), 30)}` : ""}`;
    },
    outputs: () => [
      { path: "passed", label: "passed — true when the condition held" },
      { path: "value", label: "value — the resolved value that was tested" },
    ],
  },

  human_approval: {
    type: "human_approval",
    produces:
      "decision (approve or reject) and note",
    label: "Ask a human",
    icon: "user-check",
    tile: "violet",
    stage: "Review",
    purpose:
      "OPTIONAL. Pause for a human to approve/reject before continuing. Include ONLY when an " +
      "irreversible or externally-visible action needs a safety check. Omit for safe/internal flows.",
    config: { prompt: "what the human is being asked to approve" },
    routing: ["on_approve", "on_reject"],
    defaults: { prompt: "Approve this before it goes out?" },
    fields: [
      ...TITLE_FIELDS,
      {
        key: "prompt",
        label: "What are they approving?",
        kind: "textarea",
        templated: true,
        placeholder: "Approve this reply before it is posted publicly?",
      },
    ],
    summary: (s) => truncate(str(s.prompt) || "Review before continuing"),
    outputs: () => [{ path: "decision", label: "decision — approve or reject" }],
  },

  app_action: {
    type: "app_action",
    produces:
      "result (raw provider response), url and record_id for WRITE actions; READ actions " +
      "also produce text — the fetched records as readable text, which is what an ai_step should consume",
    label: "Do something in an app",
    icon: "plug",
    tile: "green",
    stage: "Act",
    purpose:
      "Perform a REAL action in a connected app. Set 'tool' to one of the exact slugs under " +
      "AVAILABLE APP ACTIONS and fill 'arguments' per that action's arg hint. String values may " +
      "use {{steps.<id>.field}} to pass data from earlier steps.",
    config: {
      toolkit: "the app slug (e.g. 'notion', 'github')",
      tool: "the exact action slug from AVAILABLE APP ACTIONS",
      arguments: "object of arguments per the action's arg hint",
    },
    routing: ["next"],
    defaults: { arguments: {} },
    fields: [
      ...TITLE_FIELDS,
      { key: "tool", label: "Action", kind: "select", source: "tools", required: true },
      {
        key: "arguments",
        label: "Arguments",
        kind: "keyvalue",
        templated: true,
        keyLabel: "argument",
        valueLabel: "value",
        hint: "Values may reference earlier steps.",
      },
    ],
    summary: (s) => {
      const spec = getTool(str(s.tool));
      return spec ? `${appLabel(spec.app)} · ${spec.desc}` : "Pick an action";
    },
    outputs: (s) => {
      const spec = getTool(str(s.tool));
      const base = [
        { path: "result", label: "result — the raw provider response" },
        { path: "url", label: "url — link to the created record, when there is one" },
        { path: "record_id", label: "record_id — id of the created record" },
      ];
      if (spec?.kind === "read") {
        return [{ path: "text", label: "text — the fetched records as readable text" }, ...base];
      }
      return base;
    },
  },

  social_post: {
    type: "social_post",
    produces:
      "externalId (id of the published post), platform and successful",
    label: "Publish a post",
    icon: "megaphone",
    tile: "green",
    stage: "Publish",
    purpose:
      "Publish a post/message to one of the user's connected social channels. This is how the " +
      "workflow posts to X/Twitter, LinkedIn, Facebook, Instagram, Reddit, or a Slack channel.",
    config: {
      platform: "one of the SOCIAL CHANNELS listed below",
      text: "the post text, may use {{steps.<id>.field}}",
      mediaKind: 'LinkedIn media type: "auto", "image", "video", or "document" (PDF carousel)',
      mediaUrl: "optional image/video/PDF URL (REQUIRED for instagram)",
      mediaUrls: "optional 2–20 newline-separated image URLs for one LinkedIn multi-image post",
      mediaTitle: "optional human title for a LinkedIn video or PDF carousel",
      altText: "optional accessible description for a LinkedIn image",
      thumbnailUrl: "optional public thumbnail image URL for a LinkedIn video",
      websiteUrl: "optional website or deeper resource to mention at the end of a LinkedIn caption",
      linkStyle: 'LinkedIn website treatment: "none", "soft", or "direct"; prefer "soft"',
      linkLabel: "optional natural phrase before the website URL",
      options:
        'platform specifics: reddit {"subreddit","title"}, slack {"channel"} or {"dmUser":"U…"} for a direct message, linkedin {"pageId"}',
    },
    routing: ["next"],
    defaults: { text: "", mediaKind: "auto", linkStyle: "soft" },
    fields: [
      ...TITLE_FIELDS,
      { key: "platform", label: "Channel", kind: "select", source: "platforms", required: true },
      {
        key: "text",
        label: "Post text",
        kind: "textarea",
        required: true,
        templated: true,
        placeholder: "{{steps.draft.result.text}}",
      },
      {
        key: "mediaKind",
        label: "LinkedIn media",
        kind: "select",
        showIf: { key: "platform", equals: "linkedin" },
        choices: [
          { value: "auto", label: "Detect from URL" },
          { value: "image", label: "Image" },
          { value: "video", label: "Video" },
          { value: "document", label: "PDF carousel" },
        ],
        hint: "LinkedIn accepts one native media format per post.",
      },
      {
        key: "mediaUrl",
        label: "Media URL",
        kind: "text",
        templated: true,
        hint: "Use an image, video, or PDF URL. Required for Instagram.",
      },
      {
        key: "mediaUrls",
        label: "Gallery image URLs",
        kind: "textarea",
        templated: true,
        showIf: { key: "platform", equals: "linkedin" },
        placeholder: "{{steps.context.url}}\n{{steps.demo.url}}\n{{steps.logo.url}}",
        hint: "Optional: put 2–20 image URLs on separate lines. This replaces the single media URL.",
      },
      {
        key: "mediaTitle",
        label: "Media title",
        kind: "text",
        templated: true,
        showIf: { key: "mediaKind", equals: ["video", "document"] },
        hint: "Shown on a LinkedIn video or PDF carousel.",
      },
      {
        key: "altText",
        label: "Image description",
        kind: "text",
        templated: true,
        showIf: { key: "mediaKind", equals: "image" },
        hint: "Describe the image for people using screen readers.",
      },
      {
        key: "thumbnailUrl",
        label: "Video thumbnail URL",
        kind: "text",
        templated: true,
        showIf: { key: "mediaKind", equals: "video" },
      },
      {
        key: "websiteUrl",
        label: "Website (optional)",
        kind: "text",
        templated: true,
        showIf: { key: "platform", equals: "linkedin" },
        hint: "Use a relevant page when it adds context; a homepage on every post can feel promotional.",
      },
      {
        key: "linkStyle",
        label: "Link treatment",
        kind: "select",
        showIf: { key: "platform", equals: "linkedin" },
        choices: [
          { value: "soft", label: "Subtle — More context" },
          { value: "direct", label: "Direct — Learn more" },
          { value: "none", label: "Do not include" },
        ],
      },
      {
        key: "linkLabel",
        label: "Link wording (optional)",
        kind: "text",
        templated: true,
        showIf: { key: "platform", equals: "linkedin" },
        placeholder: "I wrote up the details",
        hint: "A personal phrase makes repeated automated posts feel less templated.",
      },
      {
        key: "options",
        label: "Channel options",
        kind: "keyvalue",
        templated: true,
        keyLabel: "option",
        valueLabel: "value",
        hint:
          'Reddit needs subreddit + title; Slack uses channel or dmUser (a U… member ID); LinkedIn pageId posts as a company page.',
      },
    ],
    summary: (s) => {
      const name = platformMeta(str(s.platform))?.name ?? str(s.platform) ?? "a channel";
      const text = str(s.text);
      return text ? `${name} — ${truncate(text, 60)}` : `Publish to ${name}`;
    },
    outputs: () => [
      { path: "externalId", label: "externalId — id of the published post" },
      { path: "platform", label: "platform — where it went" },
    ],
  },

  log_action: {
    type: "log_action",
    produces:
      "message — the recorded text",
    label: "Record a note",
    icon: "clipboard-check",
    tile: "green",
    stage: "Finish",
    purpose:
      "Terminal bookkeeping action (record/skip/notify-nothing). Use {{steps.X.Y}} refs in message.",
    config: { label: "short action name", message: "text, may include {{steps.id.field}}" },
    routing: ["next"],
    defaults: { label: "done", message: "" },
    fields: [
      ...TITLE_FIELDS,
      { key: "label", label: "Action name", kind: "text", placeholder: "published" },
      {
        key: "message",
        label: "Message",
        kind: "textarea",
        templated: true,
        placeholder: "Published: {{steps.draft.text}}",
      },
    ],
    summary: (s) => truncate(str(s.message) || str(s.label) || "Records the outcome"),
    outputs: () => [{ path: "message", label: "message — the recorded text" }],
  },
};

export function nodeSpec(type: string): NodeTypeSpec | undefined {
  return NODE_TYPES[type as StepType];
}

export function isTriggerType(type: string): boolean {
  return nodeSpec(type)?.trigger === true;
}

/**
 * The TOP-LEVEL keys a step's handler actually writes into the run context —
 * the contract `{{steps.<id>.<field>}}` references are checked against.
 *
 * `outputs` above is the curated subset the data picker offers; this is the
 * complete truthful shape, and it must mirror src/lib/workflows/steps.ts. A
 * reference to a key that isn't here can never resolve, so the engine would
 * pass the literal "{{…}}" through to a provider — which is exactly how a
 * workflow that builds cleanly dies on its first run.
 *
 * An empty set means "unknown shape, don't check" — never "nothing".
 */
export function outputKeys(step: StepDef): Set<string> {
  switch (step.type) {
    case "manual_trigger_input":
      return new Set(["input", "fields"]);
    case "app_event_trigger":
      return new Set(["event", "app", "trigger", "sample"]);
    case "schedule_trigger":
      return new Set(["firedAt", "cadence", "input"]);
    case "webhook_trigger":
      return new Set(["body", "received"]);
    case "ai_step":
      // The single most common authoring mistake: a text step emits `text`, a
      // json step emits `result` — they are never interchangeable.
      return step.output === "json"
        ? new Set(["result", "provider", "model", "stub_reason"])
        : new Set(["text", "provider", "model", "stub_reason"]);
    case "meeting_summary":
      return new Set(["text", "meetingId", "provider", "model", "chunks"]);
    case "generate_image":
      return new Set(["url", "provider", "aspect"]);
    case "branch":
      return new Set([str(step.key) || str(step.branch_on) || "value", "branched_on"]);
    case "filter":
      return new Set(["passed", "value", "operator", "compared_to", "unresolved"]);
    case "human_approval":
      return new Set(["decision", "note", "auto"]);
    case "app_action":
      // `text` only exists on READ actions, but an unknown/blank tool slug must
      // not produce a false "invalid reference" while the step is half-built.
      return new Set(["tool", "successful", "simulated", "result", "url", "record_id", "text"]);
    case "social_post":
      return new Set(["platform", "successful", "externalId", "simulated"]);
    case "log_action":
      return new Set(["performed", "message"]);
    default:
      return new Set();
  }
}

/**
 * The single path downstream steps almost always mean when they reference this
 * step — used to repair a reference that names a key the step cannot produce.
 * Null when the step has no one obvious payload to point at.
 */
export function primaryOutputPath(step: StepDef): string | null {
  switch (step.type) {
    case "ai_step": {
      if (step.output !== "json") return "text";
      const schema = (step.schema as Record<string, string>) ?? {};
      const keys = Object.keys(schema);
      // One schema key is unambiguous; several are not, so point at the object.
      return keys.length === 1 ? `result.${keys[0]}` : "result";
    }
    case "meeting_summary":
      return "text";
    case "app_action":
      return getTool(str(step.tool))?.kind === "read" ? "text" : "result";
    case "generate_image":
      return "url";
    case "log_action":
      return "message";
    case "human_approval":
      return "decision";
    case "filter":
      return "value";
    case "schedule_trigger":
      return "firedAt";
    default:
      return null;
  }
}

/** Every reference path the picker offers for a step, for error messages. */
export function outputPathsOf(step: StepDef): string[] {
  return (nodeSpec(step.type)?.outputs?.(step) ?? []).map((o) => o.path);
}

// ---------------------------------------------------------------------------
// What a schedule IS
//
// One reading of a schedule_trigger's config, shared by the label, the slot
// maths, the validator, the AI compiler's prompt and the editor — so none of
// them can disagree about what a stored step means. A routine you can tap out
// in the editor is therefore exactly a routine the chat can ask for.
//
// Deliberately a SUPERSET of the original three-cadence shape rather than a
// replacement. A step saved before intervals existed has no `every` and no
// `weekdays`, and reads back as precisely what it always meant, which is why
// there is no migration and no rewrite of live rows:
//
//   {cadence:"daily",  hour:9}              → every day at 9
//   {cadence:"weekly", weekday:1, hour:9}   → every Monday at 9
//   {cadence:"hourly"}                      → every hour
// ---------------------------------------------------------------------------

/** Longest interval each unit accepts — also where the editor's stepper stops. */
export const MAX_EVERY_DAYS = 30;
export const MAX_EVERY_HOURS = 23;

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** Monday first — the order the day circles are drawn in, and how days sort. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function byWeekOrder(a: number, b: number): number {
  return ((a + 6) % 7) - ((b + 6) % 7);
}

export interface ScheduleSpec {
  unit: "hour" | "day" | "week";
  /** Units between runs. Always >= 1, and always 1 for "week". */
  every: number;
  /** Hour of day. Meaningless for "hour", where there is no anchor in the day. */
  hour: number;
  /** Days it runs on, "week" only. Never empty. */
  weekdays: number[];
  /** Civil date the interval counts from; "day" with every > 1 only. */
  start?: string;
}

/** Coerce to a whole number inside a range, falling back rather than throwing. */
function clampInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}

export function scheduleSpec(step: StepDef): ScheduleSpec {
  const cadence = str(step.cadence) || "daily";
  const hour = clampInt(step.hour, 0, 23, 9);

  if (cadence === "hourly") {
    return {
      unit: "hour",
      every: clampInt(step.every, 1, MAX_EVERY_HOURS, 1),
      hour,
      weekdays: [1],
    };
  }

  if (cadence === "weekly") {
    // `weekdays` when it is there, the original single `weekday` when it is
    // not. Duplicates collapse so a graph listing Monday twice still fires once.
    const raw: unknown[] = Array.isArray(step.weekdays) ? step.weekdays : [step.weekday];
    const days = [...new Set(raw.map((d) => clampInt(d, 0, 6, 1)))].sort(byWeekOrder);
    return { unit: "week", every: 1, hour, weekdays: days.length ? days : [1] };
  }

  const every = clampInt(step.every, 1, MAX_EVERY_DAYS, 1);
  const start =
    typeof step.start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(step.start)
      ? step.start
      : undefined;
  return { unit: "day", every, hour, weekdays: [1], ...(start ? { start } : {}) };
}

/**
 * Human-readable routine for a schedule_trigger step.
 *
 * It said "09:00 UTC" unconditionally, which was true only by accident — the
 * hour is now interpreted in the workspace's own zone. Callers that know the
 * zone pass it; the rest simply don't claim one.
 */
export function scheduleLabel(step: StepDef, timeZone?: string): string {
  const spec = scheduleSpec(step);
  const zone = timeZone ? ` ${safeTimeZone(timeZone)}` : "";
  const at = ` at ${formatHour12(spec.hour)}${zone}`;

  if (spec.unit === "hour") {
    return spec.every === 1 ? "Every hour" : `Every ${spec.every} hours`;
  }
  if (spec.unit === "day") {
    if (spec.every === 1) return `Every day${at}`;
    if (spec.every === 2) return `Every other day${at}`;
    return `Every ${spec.every} days${at}`;
  }
  return `${weekdayPhrase(spec.weekdays)}${at}`;
}

/**
 * The days as a person would say them: "Every weekday", not "Every Monday,
 * Tuesday, Wednesday, Thursday and Friday". The named forms are the only reason
 * a five-day routine reads as one idea on a card.
 */
export function weekdayPhrase(weekdays: number[]): string {
  const key = [...weekdays].sort().join(",");
  if (key === "0,1,2,3,4,5,6") return "Every day";
  if (key === "1,2,3,4,5") return "Every weekday";
  if (key === "0,6") return "Every Saturday and Sunday";
  const names = [...weekdays].sort(byWeekOrder).map((d) => WEEKDAY_NAMES[d]);
  if (names.length === 1) return `Every ${names[0]}`;
  return `Every ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// Schedules
//
// Dueness is answered as a SLOT — the instant the workflow was supposed to
// fire — rather than a boolean. Everything downstream needs the slot, not the
// verdict: it is the trigger's idempotency key, so a beat that runs late, or
// a slot the bounded sweep skipped, still fires that slot exactly once when it
// is next reached; and two overlapping beats racing a stale lastFiredAt still
// produce one run, because they compute the same key.
//
// `lastFiredAt` therefore records the SLOT that fired, not the wall time it
// happened to fire at. That is what makes "is a new slot available?" a plain
// comparison instead of the old elapsed-time slack arithmetic.
// ---------------------------------------------------------------------------

/**
 * The zone's UTC offset (ms) at a given instant. Intl is the only thing in the
 * platform that knows about DST transitions, so it does the work.
 */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - at.getTime() + (at.getTime() % 1000);
}

/** A timezone the platform actually knows, falling back to UTC. */
export function safeTimeZone(timeZone: string | null | undefined): string {
  const zone = (timeZone ?? "").trim();
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return "UTC";
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  weekday: number;
}

/** Wall-clock calendar fields for an instant, as seen in `timeZone`. */
function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    weekday: Math.max(0, days.indexOf(get("weekday"))),
  };
}

/** The instant at which a wall-clock time in `timeZone` occurs. */
function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour);
  // One correction pass, then a second in case the first landed on the other
  // side of a DST transition and the offset changed underneath it.
  let ts = wall - zoneOffsetMs(new Date(wall), timeZone);
  ts = wall - zoneOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

/**
 * The most recent slot this schedule was due to fire at, at or before `now`,
 * or null if the schedule has never come due yet.
 */
export function scheduleSlot(step: StepDef, now: Date, timeZone = "UTC"): Date | null {
  const spec = scheduleSpec(step);
  const zone = safeTimeZone(timeZone);

  // Hours have no anchor inside the day, so the slot is the last boundary of
  // the interval measured from the epoch. No zone can shift which boundary we
  // are past, and every beat computes the same one. With every = 1 this is the
  // top of the current hour, exactly as before.
  if (spec.unit === "hour") {
    const size = spec.every * 3_600_000;
    return new Date(Math.floor(now.getTime() / size) * size);
  }

  const here = zonedParts(now, zone);

  if (spec.unit === "week") {
    const days = new Set(spec.weekdays);
    // Walk BACK to the last chosen day whose hour has passed. Stepping back is
    // the whole fix for weekly: the old check demanded `now.getUTCDay() ===
    // weekday`, so a beat that was down all Monday waited a further week rather
    // than firing Monday's slot on Tuesday.
    for (let back = 0; back <= 7; back++) {
      const p = zonedParts(new Date(now.getTime() - back * 86_400_000), zone);
      if (!days.has(p.weekday)) continue;
      const slot = zonedTimeToUtc(p.year, p.month, p.day, spec.hour, zone);
      if (slot.getTime() <= now.getTime()) return slot;
    }
    return null;
  }

  // Every day: today at `hour` locally, or yesterday's if today's hasn't
  // arrived. No anchor needed, and unchanged from the original daily.
  if (spec.every === 1) {
    const today = zonedTimeToUtc(here.year, here.month, here.day, spec.hour, zone);
    if (today.getTime() <= now.getTime()) return today;
    const y = zonedParts(new Date(now.getTime() - 86_400_000), zone);
    const yesterday = zonedTimeToUtc(y.year, y.month, y.day, spec.hour, zone);
    return yesterday.getTime() <= now.getTime() ? yesterday : null;
  }

  // A longer interval counts civil days from `start`. The anchor has to be a
  // FIXED date: anchoring on "today" would make every day divisible by itself
  // and fire daily. A step with no start falls back to the epoch — an arbitrary
  // phase, but a stable one, which is what dueness needs.
  const anchor = spec.start ? civilDayIndex(spec.start) : 0;
  // Among any `every` consecutive days exactly one is on the beat, so looking
  // back that far finds it — plus one more, for when today is the day but its
  // hour has not arrived and the answer is the previous occurrence.
  for (let back = 0; back <= spec.every; back++) {
    const p = zonedParts(new Date(now.getTime() - back * 86_400_000), zone);
    const diff = dayIndex(p) - anchor;
    if (diff < 0 || diff % spec.every !== 0) continue;
    const slot = zonedTimeToUtc(p.year, p.month, p.day, spec.hour, zone);
    if (slot.getTime() <= now.getTime()) return slot;
  }
  return null;
}

/**
 * The next `count` instants this schedule will fire, strictly after `from`.
 *
 * The mirror of `scheduleSlot`, and the only reason the editor can promise
 * anything: a routine like "every 3 days" is unreadable as a sentence but
 * obvious as five dates, and seeing them BEFORE switching the automation on is
 * what stops one firing more often than intended — which on a paid workflow is
 * spent credits. Same spec, same zone, same arithmetic as the sweep, so what
 * the editor shows is what will actually happen.
 */
export function nextSlots(step: StepDef, from: Date, count: number, timeZone = "UTC"): Date[] {
  const spec = scheduleSpec(step);
  const zone = safeTimeZone(timeZone);
  const out: Date[] = [];

  if (spec.unit === "hour") {
    const size = spec.every * 3_600_000;
    let t = Math.floor(from.getTime() / size) * size;
    while (out.length < count) {
      t += size;
      out.push(new Date(t));
    }
    return out;
  }

  const anchor = spec.start ? civilDayIndex(spec.start) : 0;
  const days = new Set(spec.weekdays);
  // A year bounds the walk. It is far more than `count` runs of the longest
  // interval we allow, and it stops a schedule that can somehow never fire
  // from spinning.
  for (let ahead = 0; ahead <= 366 && out.length < count; ahead++) {
    const p = zonedParts(new Date(from.getTime() + ahead * 86_400_000), zone);
    if (spec.unit === "week") {
      if (!days.has(p.weekday)) continue;
    } else if (spec.every > 1) {
      const diff = dayIndex(p) - anchor;
      if (diff < 0 || diff % spec.every !== 0) continue;
    }
    const slot = zonedTimeToUtc(p.year, p.month, p.day, spec.hour, zone);
    if (slot.getTime() > from.getTime()) out.push(slot);
  }
  return out;
}

/** A stable number per civil date, so "how many days apart" ignores clocks. */
function dayIndex(p: ZonedParts): number {
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / 86_400_000);
}

function civilDayIndex(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

/**
 * The slot this schedule owes a run for, or null when it is up to date.
 *
 * `lastFiredAt` holds the last SLOT fired. An unparseable value is treated as
 * "never fired" rather than "fire now": the old code returned true outright,
 * so one corrupt timestamp fired the workflow every 15 minutes, at 2 credits
 * a go, until somebody noticed. Treating it as never-fired fires once and then
 * writes a good value.
 */
export function dueSlot(
  step: StepDef,
  lastFiredAt: string | undefined,
  now: Date,
  timeZone = "UTC",
): Date | null {
  const slot = scheduleSlot(step, now, timeZone);
  if (!slot) return null;
  const lastMs = lastFiredAt ? new Date(lastFiredAt).getTime() : NaN;
  if (Number.isFinite(lastMs) && lastMs >= slot.getTime()) return null;
  return slot;
}

/** Is a scheduled trigger due to fire? */
export function isScheduleDue(
  step: StepDef,
  lastFiredAt: string | undefined,
  now: Date,
  timeZone = "UTC",
): boolean {
  return dueSlot(step, lastFiredAt, now, timeZone) !== null;
}

/** Title/summary/icon for any step, whatever its type. */
export function describeStep(step: StepDef): {
  title: string;
  summary: string;
  icon: IconName;
  tile: TileColor;
  app: string | null;
} {
  const spec = nodeSpec(step.type);
  const title =
    (typeof step.title === "string" && step.title.trim()) || spec?.label || step.type;
  return {
    title,
    summary: spec?.summary?.(step) ?? "",
    icon: stepIcon(step),
    tile: spec?.tile ?? "indigo",
    app: stepApp(step),
  };
}

/** Toolkit slug this step's logo should come from, if any. */
export function stepApp(step: StepDef): string | null {
  if (step.type === "app_event_trigger") return getTrigger(str(step.event))?.app ?? null;
  if (step.type === "app_action") return getTool(str(step.tool))?.app ?? null;
  if (step.type === "social_post") return str(step.platform) || null;
  return null;
}

/**
 * Fallback glyph per toolkit — only ever drawn when the app's real logo can't
 * be fetched (`StepTile` prefers `toolkitLogo(app)`), so these exist to keep a
 * node recognisable offline rather than to be the usual picture of it.
 */
const TOOLKIT_ICON: Record<string, IconName> = {
  gmail: "mail",
  notion: "notebook",
  googlesheets: "table",
  github: "code",
  googlecalendar: "calendar-clock",
  slack: "hash",
  shopify: "shopping-bag",
  googlebusinessprofile: "store",
  metaads: "target",
  whatsapp: "message-circle",
  linkedin: "briefcase",
  twitter: "at-sign",
  facebook: "users",
  instagram: "image",
  youtube: "video",
  reddit: "message-circle",
  tiktok: "video",
};

export function stepIcon(step: StepDef): IconName {
  const app = stepApp(step);
  if (app && TOOLKIT_ICON[app]) return TOOLKIT_ICON[app];
  return nodeSpec(step.type)?.icon ?? "sparkles";
}

/** Reference paths a step exposes to everything downstream of it. */
export function outputsOf(step: StepDef): { path: string; label: string }[] {
  return nodeSpec(step.type)?.outputs?.(step) ?? [];
}

// ---------------------------------------------------------------------------
// The palette — what the "add a step" picker shows
// ---------------------------------------------------------------------------

export type BlockCategory = "trigger" | "ai" | "logic" | "human" | "app" | "social" | "output";

export const CATEGORY_LABELS: Record<BlockCategory, string> = {
  trigger: "Triggers",
  ai: "AI",
  logic: "Logic",
  human: "People",
  app: "Apps",
  social: "Channels",
  output: "Output",
};

export interface PaletteBlock {
  /** Unique picker id (several blocks may share one StepType). */
  id: string;
  type: StepType;
  category: BlockCategory;
  label: string;
  desc: string;
  icon: IconName;
  tile: TileColor;
  /** Logo slug, when this block belongs to a specific app/channel. */
  app?: string;
  /** Config merged into the created step, on top of the type's defaults. */
  preset?: Record<string, unknown>;
  /** Keywords for the picker's search. */
  keywords?: string;
}

function block(spec: PaletteBlock): PaletteBlock {
  return spec;
}

/** Everything the user can insert, grouped by category in the picker. */
export function palette(): PaletteBlock[] {
  const blocks: PaletteBlock[] = [
    // Triggers
    block({
      id: "trigger:manual",
      type: "manual_trigger_input",
      category: "trigger",
      label: "Run manually",
      desc: "You start it from this page, or with Run.",
      icon: "mouse-pointer-click",
      tile: "indigo",
      keywords: "manual button on demand",
    }),
    block({
      id: "trigger:schedule",
      type: "schedule_trigger",
      category: "trigger",
      label: "On a schedule",
      desc: "Hourly, daily, or weekly — no clicks needed.",
      icon: "calendar-clock",
      tile: "indigo",
      keywords: "cron daily weekly recurring every",
    }),
    block({
      id: "trigger:webhook",
      type: "webhook_trigger",
      category: "trigger",
      label: "Webhook",
      desc: "Fires when another system POSTs JSON to your URL.",
      icon: "webhook",
      tile: "indigo",
      keywords: "http post incoming api zapier",
    }),

    // AI
    block({
      id: "ai:write",
      type: "ai_step",
      category: "ai",
      label: "Write with AI",
      desc: "Draft a post, reply, summary, or email body.",
      icon: "claude",
      tile: "tan",
      preset: { output: "text", title: "Draft with AI", stage: "Draft" },
      keywords: "draft generate compose text",
    }),
    block({
      id: "ai:extract",
      type: "ai_step",
      category: "ai",
      label: "Extract structured data",
      desc: "Pull named fields out of messy text as JSON.",
      icon: "layers",
      tile: "tan",
      preset: {
        output: "json",
        title: "Extract fields",
        stage: "Process",
        schema: { summary: "one-sentence summary" },
      },
      keywords: "parse fields json structure",
    }),
    block({
      id: "ai:classify",
      type: "ai_step",
      category: "ai",
      label: "Classify",
      desc: "Sort input into categories you can branch on.",
      icon: "target",
      tile: "tan",
      preset: {
        output: "json",
        title: "Classify the input",
        stage: "Process",
        schema: { category: "positive | negative | neutral" },
      },
      keywords: "categorize label sentiment triage",
    }),
    block({
      id: "ai:image",
      type: "generate_image",
      category: "ai",
      label: "Generate an image",
      desc: "Make an on-brand picture a post can carry.",
      icon: "image",
      tile: "tan",
      preset: { aspect: "square", title: "Generate the image", stage: "Draft" },
      keywords: "image picture photo visual asset instagram media",
    }),

    block({
      id: "ai:video",
      type: "generate_video",
      category: "ai",
      label: "Generate a video",
      desc: "Film a short branded clip a post can carry.",
      icon: "video",
      tile: "tan",
      preset: {
        kind: "shortform",
        aspectRatio: "9:16",
        durationSec: 10,
        title: "Generate the video",
        stage: "Draft",
      },
      keywords: "video clip reel film footage media instagram tiktok",
    }),

    // Logic
    block({
      id: "logic:branch",
      type: "branch",
      category: "logic",
      label: "Split into paths",
      desc: "Send each category down its own path.",
      icon: "git-branch",
      tile: "amber",
      preset: { title: "Choose a path", stage: "Route" },
      keywords: "if else switch route paths condition",
    }),
    block({
      id: "logic:filter",
      type: "filter",
      category: "logic",
      label: "Only continue if…",
      desc: "Stop the run unless a condition holds.",
      icon: "funnel",
      tile: "amber",
      preset: { title: "Only continue if", stage: "Filter" },
      keywords: "condition guard skip stop unless",
    }),

    // People
    block({
      id: "human:approval",
      type: "human_approval",
      category: "human",
      label: "Ask for approval",
      desc: "Pause until a person approves what comes next.",
      icon: "user-check",
      tile: "violet",
      preset: { title: "Review & approve", stage: "Review" },
      keywords: "human in the loop review approve reject",
    }),

    // Output
    block({
      id: "output:log",
      type: "log_action",
      category: "output",
      label: "Record a note",
      desc: "Write a line into the run log and finish.",
      icon: "clipboard-check",
      tile: "green",
      preset: { title: "Record the outcome", stage: "Finish" },
      keywords: "log note finish end record",
    }),
  ];

  // One block per app-event trigger.
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    blocks.push(
      block({
        id: `trigger:${slug}`,
        type: "app_event_trigger",
        category: "trigger",
        label: spec.desc.replace(/^Fires when /, "When "),
        desc: `${appLabel(spec.app)} · fields: ${Object.keys(spec.event).join(", ")}`,
        icon: TOOLKIT_ICON[spec.app] ?? "zap",
        tile: "indigo",
        app: spec.app,
        preset: {
          event: slug,
          app: spec.app,
          interval_minutes: 60,
          title: triggerTitle(spec.desc),
          stage: "Trigger",
          // Seed every watch setting so the inspector shows the blanks that
          // still need filling — an unconfigured trigger can't poll.
          ...Object.fromEntries(
            (spec.watch ?? []).map((w) => [`watch_${w.key}`, w.default ?? ""]),
          ),
        },
        keywords: `${slug} ${spec.app} event`,
      }),
    );
  }

  // One block per registry app action. A tool's `desc` is written for the AI
  // prompt and can carry caveats ("NOTE: LinkedIn's API does not expose…") —
  // the card shows the headline, the caveat stays in the inspector's hint.
  for (const [slug, spec] of Object.entries(TOOLS)) {
    blocks.push(
      block({
        id: `app:${slug}`,
        type: "app_action",
        category: "app",
        label: headline(spec.desc),
        desc: `${appLabel(spec.app)} · ${spec.kind === "read" ? "reads data" : "performs an action"}`,
        icon: TOOLKIT_ICON[spec.app] ?? "plug",
        tile: spec.kind === "read" ? "amber" : "green",
        app: spec.app,
        preset: {
          tool: slug,
          toolkit: spec.app,
          arguments: Object.fromEntries(spec.required.map((r) => [r, ""])),
          title: headline(spec.desc),
          stage: spec.kind === "read" ? "Fetch" : "Act",
        },
        keywords: `${slug} ${spec.app} ${spec.kind}`,
      }),
    );
  }

  // One block per publishable channel.
  for (const p of PLATFORMS) {
    if (p.id === "youtube" || p.id === "tiktok") continue; // video publishing not supported yet
    blocks.push(
      block({
        id: `social:${p.id}`,
        type: "social_post",
        category: "social",
        label: `Post to ${p.name}`,
        desc: p.description,
        icon: TOOLKIT_ICON[p.id] ?? "megaphone",
        tile: "green",
        app: p.id,
        preset: { platform: p.id, text: "", title: `Post to ${p.name}`, stage: "Publish" },
        keywords: `${p.id} publish share post`,
      }),
    );
  }

  return blocks;
}

/** First sentence of a catalog description, without any trailing caveat. */
function headline(desc: string): string {
  const cut = desc.split(/\.\s|\sNOTE:/)[0].trim();
  return truncate(cut || desc, 70);
}

function triggerTitle(desc: string): string {
  const m = desc.match(/^Fires when (.*)$/);
  const body = m ? m[1] : desc;
  return `When ${body}`.slice(0, 60);
}

/** Build the step body for a freshly inserted palette block. */
export function newStepFrom(block: PaletteBlock): StepDef {
  const spec = NODE_TYPES[block.type];
  const step: StepDef = {
    type: block.type,
    title: block.label,
    stage: spec.stage,
    ...(spec.defaults ?? {}),
    ...(block.preset ?? {}),
  };
  // A webhook trigger is useless without its token, and the token is what
  // makes the public endpoint safe — mint it at birth rather than later.
  if (step.type === "webhook_trigger" && !step.secret) step.secret = webhookSecret();
  return step;
}

/** 128 bits of URL-safe randomness for a webhook token. */
export function webhookSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Slug seed for a new step's id, derived from the block. */
export function idSeed(block: PaletteBlock): string {
  const base = (block.preset?.title as string | undefined) ?? block.label;
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .split("_")
    .slice(0, 4)
    .join("_");
  return slug || block.type;
}
