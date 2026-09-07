import { outputKeys, primaryOutputPath } from "./blocks";
import { ancestors, cloneGraph, configEntries } from "./graph";
import { getTool, isPlaceholder } from "./registry";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * Deterministic repair of data references.
 *
 * The compiler is a language model, so it reliably makes the same small class
 * of mistake: pointing at `.result` on a text-mode ai_step (which emits
 * `.text`), or at `{{steps.<trigger>.topic}}` when the value actually lands
 * under `.input.topic`. Every one of these builds and saves cleanly and then
 * fails at run time, because the engine leaves an unresolvable reference as the
 * literal string "{{…}}".
 *
 * `validateRefFields` now rejects them — but rejecting alone would just mean a
 * user watching the builder burn a repair round on a mistake we can fix
 * ourselves, exactly, without asking anyone. So references are repaired first
 * and validated second: the model's near-miss becomes the right graph, and
 * anything genuinely ambiguous still fails loudly.
 *
 * Pure and idempotent — a graph that is already correct comes back untouched,
 * which is why this is safe to run on save and before every run.
 */

export interface RefFix {
  stepId: string;
  from: string;
  to: string;
}

const REF_RE = /\{\{\s*steps\.([A-Za-z0-9_]+|<(?:ai|trigger|read|image|video)>)\.([A-Za-z0-9_.]+?)\s*\}\}/g;

/**
 * Older catalog examples used labels such as <ai> as if they were step ids.
 * They are safe to repair only when the target has exactly one matching
 * upstream step; guessing between branches would be worse than a clear build
 * error. New prompts no longer contain these examples, but this keeps saved
 * or cached model responses from failing unnecessarily.
 */
function resolvePlaceholderStep(
  graph: WorkflowGraph,
  targetId: string,
  placeholder: string,
): string | null {
  const kind = placeholder.slice(1, -1);
  const upstream = ancestors(graph, targetId);
  if (kind === "trigger") return upstream.has(graph.start) ? graph.start : null;

  const candidates = [...upstream].filter((id) => {
    const step = graph.steps[id];
    if (!step) return false;
    if (kind === "ai") return step.type === "ai_step";
    if (kind === "image") return step.type === "generate_image";
    if (kind === "video") return step.type === "generate_video";
    if (kind === "read") {
      if (step.type !== "app_action") return false;
      return getTool(String(step.tool ?? ""), step.tool_spec)?.kind === "read";
    }
    return false;
  });
  return candidates.length === 1 ? candidates[0] : null;
}

/** Triggers whose payload is nested under one container key. */
const CONTAINER_KEY: Partial<Record<string, string>> = {
  manual_trigger_input: "input",
  app_event_trigger: "event",
  webhook_trigger: "body",
};

/**
 * The path `source` really meant, or null when the reference is already valid
 * (or too ambiguous to rewrite — better a clear error than a wrong guess).
 */
function canonicalPath(source: StepDef, path: string): string | null {
  const keys = outputKeys(source);
  const [first, ...rest] = path.split(".");
  if (!keys.size || keys.has(first)) return null;

  if (source.type === "ai_step") {
    // A text step has exactly one payload; anything else pointed at it is that.
    if (source.output !== "json") return "text";
    // A json step nests everything under `result` — including a schema key the
    // author referenced directly ({{steps.x.reply}} -> {{steps.x.result.reply}}).
    const schema = (source.schema as Record<string, string>) ?? {};
    if (first in schema) return `result.${path}`;
    if (first === "text" || first === "output") {
      return rest.length ? `result.${rest.join(".")}` : primaryOutputPath(source);
    }
    return primaryOutputPath(source);
  }

  // "{{steps.trigger.topic}}" means the topic inside the trigger's payload.
  const container = CONTAINER_KEY[source.type];
  if (container) return `${container}.${path}`;

  return primaryOutputPath(source);
}

/**
 * Rewrite every unresolvable reference in `graph` to the path it meant.
 * Returns a new graph plus what changed, so callers can tell the user.
 */
export function repairRefs(graph: WorkflowGraph): { graph: WorkflowGraph; fixes: RefFix[] } {
  const fixes: RefFix[] = [];
  const repaired = cloneGraph(graph);

  const rewrite = (nodeId: string, value: unknown): unknown => {
    if (typeof value === "string") {
      return value.replace(REF_RE, (match, rawRefId: string, path: string) => {
        const placeholderId = rawRefId.startsWith("<")
          ? resolvePlaceholderStep(repaired, nodeId, rawRefId)
          : null;
        const refId = placeholderId ?? rawRefId;
        const source = repaired.steps[refId];
        if (!source) return match; // dangling ref — validation reports it
        const fixed = canonicalPath(source, path);
        if (!placeholderId && (!fixed || fixed === path)) return match;
        const to = `{{steps.${refId}.${fixed ?? path}}}`;
        fixes.push({
          stepId: nodeId,
          from: match,
          to,
        });
        return to;
      });
    }
    if (Array.isArray(value)) return value.map((v) => rewrite(nodeId, v));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewrite(nodeId, v)]),
      );
    }
    return value;
  };

  for (const [nodeId, node] of Object.entries(repaired.steps)) {
    for (const [key, value] of configEntries(node)) {
      (node as Record<string, unknown>)[key] = rewrite(nodeId, value);
    }
  }

  return { graph: repaired, fixes };
}

/**
 * Make a compiled schedule mean what it says.
 *
 * Two deterministic near-misses, both of which build and save cleanly today
 * and then run at the WRONG frequency — the exact failure this feature exists
 * to end, so neither is worth spending a repair round on:
 *
 *  - days named on a "daily" cadence. The model reached for `weekdays` and
 *    forgot to move the cadence with it; left alone the days are ignored and
 *    the automation fires every single day.
 *  - an interval with no `start`. "Alternate days" cannot know WHICH days
 *    without a fixed date to count from, and the model is never told today's
 *    date, so it cannot supply one. The server can.
 *
 * Pure apart from reading the clock, and idempotent: a graph that is already
 * right comes back untouched.
 */
export function repairSchedules(graph: WorkflowGraph): WorkflowGraph {
  const repaired = cloneGraph(graph);
  const today = new Date().toISOString().slice(0, 10);

  for (const node of Object.values(repaired.steps)) {
    if (node.type !== "schedule_trigger") continue;
    const step = node as Record<string, unknown>;

    if (Array.isArray(step.weekdays) && step.weekdays.length > 0 && step.cadence !== "weekly") {
      step.cadence = "weekly";
      delete step.every;
    }

    // A week's rhythm is its days; there is no second interval on top of it.
    if (step.cadence === "weekly") delete step.start;

    const every = Number(step.every);
    if (step.cadence === "daily" && Number.isFinite(every) && every > 1) {
      const start = step.start;
      if (typeof start !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
        step.start = today;
      }
    }
  }

  return repaired;
}

/**
 * Blank every value the compiler answered with a stand-in.
 *
 * The same class of mistake as the references above, one field over: the model
 * is shown `argHint: '{"owner": "<org>", "repo": "<repo>"}'` and, when the
 * request never named a repository, writes `<repo>` where the answer goes.
 * That builds, saves and switches on cleanly, then asks GitHub hourly for a
 * repository called `<repo>` — which is the 404 this pass exists to prevent.
 *
 * Blanking rather than rejecting is the point: an empty field is what the
 * inspector already knows how to show ("Needs setup"), and `missingSetup` then
 * refuses to switch the automation on until a person fills it in. Rejecting
 * would burn a repair round on something we can fix exactly.
 *
 * Model output ONLY — see the call sites in builder.ts. A human typing into the
 * inspector is not copying an example, and silently erasing what they typed
 * would be a worse defect than the one this closes.
 *
 * Pure and idempotent, like `repairRefs` above.
 */
export function stripPlaceholders(
  graph: WorkflowGraph,
): { graph: WorkflowGraph; blanked: string[] } {
  const blanked: string[] = [];
  const stripped = cloneGraph(graph);

  for (const [nodeId, node] of Object.entries(stripped.steps)) {
    const step = node as Record<string, unknown>;

    // What the trigger watches: the repo, the channel, the calendar.
    for (const key of Object.keys(step)) {
      if (key.startsWith("watch_") && isPlaceholder(step[key])) {
        step[key] = "";
        blanked.push(`${nodeId}.${key}`);
      }
    }

    // Required action arguments — the ones argHint spells out by name, and so
    // the ones a model copies verbatim.
    if (step.type === "app_action") {
      const spec = getTool(String(step.tool ?? ""), step.tool_spec);
      const args = step.arguments;
      if (spec && args && typeof args === "object" && !Array.isArray(args)) {
        const record = args as Record<string, unknown>;
        for (const key of spec.required) {
          if (isPlaceholder(record[key])) {
            record[key] = "";
            blanked.push(`${nodeId}.arguments.${key}`);
          }
        }
      }
    }
  }

  return { graph: stripped, blanked };
}
