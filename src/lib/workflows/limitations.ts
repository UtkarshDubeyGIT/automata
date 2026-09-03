import { isTriggerType } from "./blocks";
import { configEntries, refsIn } from "./graph";
import {
  appLabel,
  getTool,
  getTrigger,
  isPlaceholder,
  SIMULATED_APPS,
  watchValues,
} from "./registry";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * What this automation will NOT do — stated while it is still being built.
 *
 * `validateGraph` rejects graphs that cannot run and `missingSetup` names blank
 * fields, so between them the editor already covers everything the user can
 * FIX. This covers what is left: the true things about a working automation
 * that will still surprise whoever switched it on. They share one property —
 * nothing is wrong, so nothing anywhere says anything — and they were all
 * discovered the same way, on a live run against a real account:
 *
 *  - the trigger polls, so "when a new order arrives" means "within an hour";
 *  - real-time delivery needs a `watch_*` the user left blank, so a trigger
 *    that COULD push quietly settles for checking on a schedule;
 *  - the app has no Composio toolkit, so every step against it is simulated and
 *    the reply nobody wanted to send was never sent either;
 *  - the provider forbids what the step is arranged to do — a WhatsApp template
 *    cannot carry AI-written text, LinkedIn will not report engagement.
 *
 * Pure and free of I/O, exactly like `validate.ts`: this is imported by the
 * editor and re-derived on every keystroke, and it is the same answer on the
 * server. Workspace-level facts (is GitHub connected, is an ad account saved)
 * are deliberately NOT here — the builder already resolves connections inline,
 * and a pure function cannot see them without lying about freshness.
 */

export interface Limitation {
  /** The step this is about, when it belongs to one. */
  stepId?: string;
  /** Short lead, rendered bold. */
  title: string;
  /** The sentence that explains it. */
  detail: string;
  /**
   * `delivery` — it runs later than "when it happens".
   * `simulated`  — it does not really reach the app.
   * `provider`   — the app itself forbids or omits something.
   */
  kind: "delivery" | "simulated" | "provider";
}

/**
 * What the enable path resolved, when it has run.
 *
 * Deliberately not `TriggerState`: the editor holds the rendered `Workflow`
 * view model rather than the raw row, and this has to give the same answer on
 * both sides of the wire.
 */
export interface DeliveryState {
  mode?: "realtime" | "poll";
  /** Why it fell back — only meaningful when `mode` is "poll". */
  reason?: string;
}

/** Everything true-but-surprising about this graph, most consequential first. */
export function limitations(
  graph: WorkflowGraph | undefined,
  delivery?: DeliveryState | null,
): Limitation[] {
  if (!graph?.steps) return [];
  const out: Limitation[] = [];
  const start = graph.steps[graph.start];
  if (start && isTriggerType(start.type)) out.push(...triggerLimits(graph.start, start, delivery));
  for (const [id, step] of Object.entries(graph.steps)) out.push(...stepLimits(graph, id, step));
  // One line per app, not one per step that touches it — see simulatedLimits.
  out.push(...simulatedLimits(graph));

  // Simulated beats delivery beats provider: "this never really posts" changes
  // whether the automation is worth building at all, a delay changes when it is
  // useful, and a provider rule changes one step.
  const rank = { simulated: 0, delivery: 1, provider: 2 } as const;
  return dedupe(out).sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Drop lines that say exactly the same thing twice.
 *
 * A graph routinely holds several steps doing the same thing to the same app
 * — three branches of "reply to the review", one per sentiment — and each of
 * them carrying an identical sentence turns the panel into wallpaper. The
 * first one keeps its `stepId`, so the line still selects a step that shows
 * what it is about.
 */
function dedupe(items: Limitation[]): Limitation[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}|${item.title}|${item.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * "Nothing here reaches <app>" — said once per app, however many steps use it.
 *
 * This is one fact about a connection, not a fact about each step: a workflow
 * with a Google Business Profile trigger and three GBP actions used to print
 * four paragraphs, three of them byte-identical (the branches share a title),
 * all repeating the same sentence about the same missing connection. Grouped,
 * it is the sentence someone will actually read — and the count is the part
 * that carries information the trigger line doesn't.
 */
function simulatedLimits(graph: WorkflowGraph): Limitation[] {
  const byApp = new Map<string, { triggerId?: string; steps: { id: string; title: string }[] }>();
  const entry = (app: string) => {
    const found = byApp.get(app) ?? { steps: [] };
    byApp.set(app, found);
    return found;
  };

  const start = graph.steps[graph.start];
  if (start?.type === "app_event_trigger") {
    const spec = getTrigger(String(start.event ?? ""));
    if (spec && SIMULATED_APPS.has(spec.app)) entry(spec.app).triggerId = graph.start;
  }
  for (const [id, step] of Object.entries(graph.steps)) {
    if (step.type !== "app_action") continue;
    const spec = getTool(String(step.tool ?? ""));
    if (!spec || !SIMULATED_APPS.has(spec.app)) continue;
    entry(spec.app).steps.push({ id, title: title(step, id) });
  }

  const out: Limitation[] = [];
  for (const [app, { triggerId, steps }] of byApp) {
    const name = appLabel(app);
    const noLive = `There is no live ${name} connection`;
    // The trigger is the honest anchor when there is one: it is where the
    // automation fails to start, and it is the top of the canvas.
    const stepId = triggerId ?? steps[0]?.id;
    const sample = "Press Run to try it end to end on the trigger's sample event.";
    // `phrase` renders a single step as a bare “title”, so the verb has to
    // agree with the count — otherwise it reads "“Post the reply” produce a
    // realistic result", which looks like a bug in the product.
    const produce = steps.length === 1 ? "produces a realistic result" : "produce realistic results";

    if (triggerId && steps.length) {
      out.push({
        stepId,
        kind: "simulated",
        title: `${name} runs in demo mode`,
        detail: `${noLive}, so this never starts by itself and ${phrase(steps)} ${produce} without anything reaching ${name}. ${sample}`,
      });
    } else if (triggerId) {
      out.push({
        stepId,
        kind: "simulated",
        title: `${name} can't be watched automatically`,
        detail: `${noLive} available, so this never starts by itself. ${sample}`,
      });
    } else {
      out.push({
        stepId,
        kind: "simulated",
        title:
          steps.length === 1
            ? `“${steps[0].title}” runs in demo mode`
            : `${steps.length} steps run in demo mode`,
        detail: `${noLive}, so ${phrase(steps)} ${produce} without anything reaching ${name}.`,
      });
    }
  }
  return out;
}

/**
 * How to name the affected steps: by title while the titles distinguish them,
 * by count once they don't. Three branches called "Post the reply" is the
 * common case, and quoting it three times says nothing the number doesn't.
 */
function phrase(steps: { title: string }[]): string {
  const names = [...new Set(steps.map((s) => s.title))];
  if (names.length !== steps.length || names.length > 3) {
    return `${steps.length} step${steps.length === 1 ? "" : "s"}`;
  }
  const quoted = names.map((n) => `“${n}”`);
  if (quoted.length === 1) return quoted[0];
  return `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

function cadence(step: StepDef): string {
  const raw = Number(step.interval_minutes);
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : 60;
  if (minutes >= 120) return `every ${Math.round(minutes / 60)} hours`;
  if (minutes >= 60) return "every hour";
  return `every ${minutes} minutes`;
}

function triggerLimits(
  stepId: string,
  step: StepDef,
  delivery?: DeliveryState | null,
): Limitation[] {
  if (step.type !== "app_event_trigger") return [];
  const spec = getTrigger(String(step.event ?? ""));
  if (!spec) return [];
  const app = appLabel(spec.app);

  // No toolkit at all: the sweep only stamps lastCheckedAt for these, so the
  // automation genuinely never starts on its own however it is configured —
  // and how fast it would poll is beside the point when nothing polls it.
  // Said once, with the steps it affects, by `simulatedLimits`.
  if (SIMULATED_APPS.has(spec.app)) return [];

  const every = cadence(step);

  // Already switched on: the enable path resolved this for real, and its answer
  // beats anything derivable here. `reason` was previously written to
  // trigger_state and read by nothing.
  if (delivery?.mode === "realtime") return [];
  if (delivery?.reason) {
    return [
      {
        stepId,
        kind: "delivery",
        title: `Checked ${every}, not the moment it happens`,
        detail: delivery.reason,
      },
    ];
  }

  if (!spec.realtime) {
    return [
      {
        stepId,
        kind: "delivery",
        title: `Checked ${every}`,
        detail: `${app} offers no way to push this event, so new items are picked up on the next check — anything that arrives just after one waits until the following one.`,
      },
    ];
  }

  // It COULD push, but only once the keys the trigger type declares are filled
  // in. Blank ones cost real time silently, which is the whole point of saying
  // so before rather than after.
  const set = watchValues(step);
  const unmet = (spec.realtime.needs ?? []).filter((key) => !set[key]);
  if (unmet.length) {
    const labels = unmet.map(
      (key) => spec.watch?.find((w) => w.key === key)?.label ?? key,
    );
    return [
      {
        stepId,
        kind: "delivery",
        title: `Fill in ${labels.map((l) => `“${l}”`).join(" and ")} to run in real time`,
        // What the blank costs is real time, and that is the whole of what the
        // user can act on. Quoting the fallback cadence here would put a number
        // on a path we neither show nor let them set.
        detail: `${app} will only push this event when it knows ${labels.join(" and ")}. Without ${unmet.length === 1 ? "it" : "them"} the automation still runs, just not the moment it happens.`,
      },
    ];
  }

  // Real time is reachable and everything it needs is filled in. We ask for a
  // push and quietly poll if we don't get one, and saying so here would warn
  // about a fallback that hasn't happened and usually won't. If it does happen,
  // `delivery.reason` above reports it — after the fact, from what the enable
  // path actually resolved, rather than as a caveat on a working automation.
  return [];
}

function stepLimits(graph: WorkflowGraph, id: string, step: StepDef): Limitation[] {
  /*
   * An image is the one step that spends real money every time the automation
   * fires, on top of the run itself. On a manual workflow that is obvious —
   * you pressed the button. On an hourly schedule or a per-order trigger it is
   * not, and the first time anyone finds out is the credit balance. Stated
   * here rather than as a `missingSetup` entry because there is nothing to fix:
   * it is a true fact about a working automation, which is exactly what this
   * panel is for.
   */
  if (step.type === "generate_image") {
    return [
      {
        stepId: id,
        kind: "provider",
        title: `“${title(step, id)}” costs credits on every run`,
        detail:
          "Generating an image spends credits each time this automation fires, not once when you build it. On a frequent trigger that adds up — the Runs tab shows how often it actually fires.",
      },
    ];
  }
  /*
   * A video costs what an image costs, and then costs TIME as well — which is
   * the part nobody expects from a step. The run genuinely stops here for
   * minutes and resumes itself, so a "post at 9am" automation carrying a video
   * publishes at ten past. Said here because it is a true fact about a working
   * automation rather than something to fix.
   */
  if (step.type === "generate_video") {
    return [
      {
        stepId: id,
        kind: "provider",
        title: `“${title(step, id)}” pauses the run while it renders`,
        detail:
          "Rendering a clip takes several minutes, so the run stops at this step and picks itself back up when the video is ready — anything after it, including publishing, happens then rather than immediately. It also spends credits every time the automation fires, and a longer clip costs more than a short one.",
      },
    ];
  }
  if (step.type !== "app_action") return [];
  const slug = String(step.tool ?? "");
  const spec = getTool(slug);
  if (!spec) return [];
  const out: Limitation[] = [];
  const name = title(step, id);
  const app = appLabel(spec.app);

  for (const detail of spec.limits ?? []) {
    out.push({ stepId: id, kind: "provider", title: `“${name}” — ${app}`, detail });
  }

  /*
   * A template step wired to an AI step. This is not a hypothetical: the
   * obvious way to build "message the customer about their order" is an
   * ai_step writing the message and a WhatsApp step sending it, and the
   * template tool is the one that reaches a customer who hasn't written first
   * — so the two get combined, validate clean (the reference resolves, the
   * field exists), and send the approved wording with the draft silently
   * dropped by WhatsApp. Worth naming the step it comes from, because the
   * fix is to route it to WHATSAPP_SEND_MESSAGE or drop the AI step.
   */
  if (slug === "WHATSAPP_SEND_TEMPLATE_MESSAGE") {
    const sources = [...aiSources(graph, step)];
    if (sources.length) {
      out.push({
        stepId: id,
        kind: "provider",
        title: `“${name}” can't send what ${sources.map((s) => `“${s}”`).join(" or ")} writes`,
        detail:
          "WhatsApp templates send the wording approved in WhatsApp Manager, so text drafted by an AI step is dropped. Use “Send a WhatsApp message” for your own wording — it reaches anyone who has messaged you in the last 24 hours.",
      });
    }
  }

  /*
   * Meta's insights call requires object_id; the registry deliberately does not
   * (steps.ts autofills the workspace's saved ad account), which is why this is
   * not a `missingSetup` entry. The cost of that convenience is a dependency on
   * a setting made somewhere else entirely, and nothing in this editor mentions
   * it — so a workspace that never saved an ad account gets a step that looks
   * complete and fails on its first run.
   */
  if (slug === "METAADS_GET_INSIGHTS") {
    const args = (step.arguments as Record<string, unknown>) ?? {};
    const objectId = args.object_id;
    if (objectId == null || String(objectId).trim() === "" || isPlaceholder(objectId)) {
      out.push({
        stepId: id,
        kind: "provider",
        title: `“${name}” uses the ad account from Settings`,
        detail:
          "Leaving the ad account blank means this reads whichever one is saved under Settings → Paid channels. If none is saved there yet, this step fails on the first run.",
      });
    }
  }

  return out;
}

/** ai_step ids this step pulls a `{{steps.X.…}}` value from, by title. */
function aiSources(graph: WorkflowGraph, step: StepDef): Set<string> {
  const found = new Set<string>();
  for (const [, value] of configEntries(step)) {
    for (const refId of refsIn(value)) {
      const source = graph.steps[refId];
      if (source?.type === "ai_step") found.add(title(source, refId));
    }
  }
  return found;
}

function title(step: StepDef, fallback: string): string {
  return typeof step.title === "string" && step.title.trim() ? step.title.trim() : fallback;
}
