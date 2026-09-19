import { chat, openaiConfigured } from "@/lib/ai/openai";
import { env } from "@/lib/env";
import type { ResponseSegment, WorkflowGroup } from "@/lib/data/workflows";
import { findToolSpec, PLATFORMS } from "@/lib/social/composio";
import { needsBrandGrounding, requiredAppsOf, type RequiredApp } from "./apps";
import { NODE_TYPES } from "./blocks";
import { buildResponse, deriveDisplay } from "./display";
import { repairRefs, repairSchedules, stripPlaceholders } from "./repair";
import { getTool, triggersForPrompt } from "./registry";
import { selectTools } from "./tool-selection";
import { BuildError, validateGraph } from "./validate";
import type { ToolSpec } from "./registry";
import type { StepDef, WorkflowConfig, WorkflowGraph } from "./types";
import { setupNotice } from "@/lib/setup-notice";

/**
 * Chat-to-build — TypeScript port of relay_poc/builder.py.
 *
 * The LLM is NOT allowed to freestyle: it must emit a graph using only the
 * node catalog in ./blocks.ts — the very same catalog the visual editor's
 * palette and inspector are generated from, which is why anything the AI
 * builds can be opened and edited by hand, and vice versa. The result is
 * validated (structure, tools, routing, dataflow) and repaired via
 * re-prompting when malformed. An invalid graph never reaches the engine.
 */

export { BuildError, validateGraph };

/** The model deliberately declined (unsupported request) — don't retry. */
class BuildRefusal extends Error {}

/**
 * The AI provider itself failed (quota, auth, rate limit, outage) rather than
 * returning a bad graph. Distinct from BuildError so the repair loop aborts
 * instead of spending two more calls on a request that cannot succeed.
 */
class ProviderError extends BuildError {}

/**
 * Turn a provider failure into a message that says what to actually do about
 * it. "Try again" is actively wrong for an exhausted quota or a rejected key —
 * and every one of these still leaves the visual editor fully usable, which
 * the message should say.
 */
function providerError(err: unknown): ProviderError | null {
  const status = (err as { status?: number })?.status;
  const message = String((err as Error)?.message ?? "");
  const name = String((err as Error)?.name ?? "");
  const byHand = " You can still build and edit this workflow by hand on the canvas.";

  if (/timeout/i.test(name) || /timed? out|timeout/i.test(message)) {
    return new ProviderError("The builder took too long this time — please try again.");
  }

  if (status === 429 && /quota|billing|insufficient/i.test(message)) {
    return new ProviderError(
      setupNotice(
        "The AI builder has run out of capacity on our side, so it can't run right now.",
        "The OpenAI account attached to this app has run out of quota, so the AI builder can't run. " +
          "Add billing credit (or point OPENAI_API_KEY at a funded key) and it works again.",
      ) + byHand,
    );
  }
  if (status === 429) {
    return new ProviderError("OpenAI is rate-limiting right now — wait a few seconds and try again.");
  }
  if (status === 401 || status === 403) {
    return new ProviderError(
      setupNotice(
        "The AI builder can't reach the AI service right now.",
        "OpenAI rejected the API key — check OPENAI_API_KEY in your environment.",
      ) + byHand,
    );
  }
  if (status === 404) {
    return new ProviderError(
      setupNotice(
        "The AI builder can't use the model it is set up for right now.",
        `This key has no access to the model “${env.openaiModel}” — set OPENAI_MODEL to one it can use.`,
      ) + byHand,
    );
  }
  if (typeof status === "number" && status >= 500) {
    return new ProviderError("OpenAI is having trouble right now — try again in a moment.");
  }
  return null;
}

export type { RequiredApp };
export { needsBrandGrounding, requiredAppsOf };

export interface BuildOutput {
  name: string;
  description: string;
  config: WorkflowConfig;
  response: ResponseSegment[][];
  groups: WorkflowGroup[];
  simulated: boolean;
  /** Accounts the workflow needs — the chat renders inline connect rows for these. */
  requiredApps: RequiredApp[];
  /** Does it generate copy or images? Then the brand profile decides how good they are. */
  needsBrand: boolean;
}

// ---------------------------------------------------------------------------
// The node catalog — the contract. Not in ./blocks.ts = the AI cannot emit it.
// ---------------------------------------------------------------------------

function catalogForPrompt(): string {
  return Object.entries(NODE_TYPES)
    .map(([name, spec]) => {
      const cfg = Object.entries(spec.config)
        .map(([k, v]) => `${k}: ${v}`)
        .join(", ");
      return (
        `- ${name}: ${spec.purpose}\n    config: {${cfg}}\n` +
        `    routing keys: ${spec.routing.join(" | ")}\n` +
        `    OUTPUT (what later steps may reference): ${spec.produces}`
      );
    })
    .join("\n");
}

function socialChannelsForPrompt(): string {
  return PLATFORMS.filter((p) => p.id !== "tiktok")
    .map((p) => `  - ${p.id}: ${p.name} — ${p.description}`)
    .join("\n");
}

function systemPrompt(toolCatalog: string): string {
  return `You are a workflow compiler. You turn a user's plain-English automation request into a STRICT JSON workflow graph that a deterministic engine will execute.

You may ONLY use these node types:

${catalogForPrompt()}

AVAILABLE TRIGGERS (use these exact slugs in the app_event_trigger 'event' field; do NOT invent triggers):
${triggersForPrompt()}

AVAILABLE APP ACTIONS (use these exact tool slugs in app_action steps; do NOT invent slugs; READ actions produce data for later steps, WRITE actions perform an action; [external/visible] actions affect other people -> consider approval):
${toolCatalog}

IMPORTANT: Any angle-bracket label shown inside catalog documentation (for example <ai>, <trigger>, or <id>) is explanatory text, never a real step id. Do not copy it into the JSON. Choose a real snake_case id from the steps you create for every {{steps.…}} reference. Action argument examples intentionally use empty strings; fill them with a literal supplied by the user or a reference to an earlier step.

SOCIAL CHANNELS for social_post (do NOT use tiktok — its publishing API is not available yet). A youtube post REQUIRES a video: pair it with a generate_video step earlier in the graph, or do not use youtube at all:
${socialChannelsForPrompt()}

RULES:
1. Output ONLY a single JSON object. No markdown, no commentary.
2. The graph shape is exactly:
   {
     "workflow_id": "<snake_case_short_name>",
     "title": "<human readable title, max 5 words>",
     "description": "<one short sentence describing the outcome>",
     "start": "<id of the first node>",
     "steps": {
        "<node_id>": { "type": "<one of the allowed types>", "title": "...", "stage": "...", ...config..., ...routing... }
     }
   }
3. The FIRST node MUST be a trigger, and NO other node may be a trigger. Choose:
   - "app_event_trigger" when the user describes an event ("when a customer leaves a
     review", "whenever an order comes in") AND a matching trigger exists under
     AVAILABLE TRIGGERS;
   - "schedule_trigger" when the user describes ANY repeating routine ("every day",
     "every Monday", "every Monday, Saturday and Sunday", "alternate days", "once
     every 3 days", "every 6 hours", "hourly") — no polling app needed. Every
     routine of that shape IS expressible; rule 3f says exactly how. NEVER
     substitute a frequency the user did not ask for;
   - "webhook_trigger" when the user describes another system calling in;
   - otherwise "manual_trigger_input".
   Give the trigger a natural title like "New Google Review" or "Every Monday 9am".
   For app_event_trigger, steps reference the event via {{steps.<trigger_id>.event.<field>}}
   (only the listed event fields). For manual_trigger_input, runs may start with EMPTY
   input, so ai_step instructions must be self-sufficient — bake the concrete
   topic/details from the user's request into the instruction text itself. NEVER make
   an instruction depend on a manual input field being filled (fields are optional extras).
3f. SCHEDULES: SET WHAT WAS ASKED FOR, NEVER SOMETHING NEARBY. schedule_trigger
   has cadence, every, weekdays, hour and start, and between them they cover
   every time-defined routine. Map the request like this:
     "every day at 9am"                 -> cadence "daily",  every 1,  hour 9
     "alternate days" / "every other day" -> cadence "daily", every 2,  hour
     "once every 3 days"                -> cadence "daily",  every 3,  hour
     "every 10 days"                    -> cadence "daily",  every 10, hour
     "every Monday at 9am"              -> cadence "weekly", weekdays [1], hour 9
     "Monday, Saturday and Sunday"      -> cadence "weekly", weekdays [1,6,0], hour
     "every weekday"                    -> cadence "weekly", weekdays [1,2,3,4,5], hour
     "weekends"                         -> cadence "weekly", weekdays [6,0], hour
     "every other Monday"               -> cadence "daily",  every 14, hour
                                           (there is no fortnightly weekday)
     "every hour" / "every 6 hours"     -> cadence "hourly", every 1 / every 6
   "weekdays" belongs ONLY to cadence "weekly" — putting days on a "daily"
   cadence means they are ignored and it runs every single day. "every" belongs
   ONLY to "daily" and "hourly" (max 30 and 23). Omit "start"; the server fills
   in the date an interval counts from.
   Runs fire on the hour, so round "8:30am" to the nearest hour rather than
   dropping the request. If the user asks for something none of the above can
   express (a specific minute, a calendar month, more than once a day), choose
   the closest thing that IS expressible and say which in "description" — for
   example "Runs every 30 days (calendar months aren't supported)". Choosing a
   different frequency without saying so is the one thing you must never do.
3e. NEVER INVENT A TARGET THE USER DID NOT GIVE YOU. If the request does not name
   the repository, channel, calendar, spreadsheet, page or recipient, set that
   watch_* value or that argument to an EMPTY STRING "" and move on — the user
   fills it in before switching the automation on, and the editor badges it
   "Needs setup" until they do. Never write "<owner>", "<repo>", "<id>",
   "a@b.com", "..." or any other stand-in as a VALUE: a stand-in reads as a real
   answer to everything downstream and becomes a 404 against somebody's live
   account. An empty string is the honest answer, and it is always accepted.
   (This is about VALUES only. Inside a {{steps....}} reference you must still
   write the real node id you chose.)
4. Use snake_case node ids that describe the step (e.g. "draft_post").
5. EVERY step must include "title" (max 8 words, verb-led, e.g. "Draft the weekly summary") and "stage" (a 1-2 word phase label like "Trigger", "Research", "Draft & review", "Publish"). Consecutive steps sharing a stage are grouped in the UI.
6. Linear steps use "next": "<id>". A terminal step uses "next": null.
7. "on_approve"/"on_reject" belong to human_approval and to NO other step type (both must point to real node ids or null). Only human_approval produces a decision, so these keys on any other step mean nobody is ever asked and every run takes the reject path. To gate a step, insert a human_approval BEFORE it and route "on_approve" to it — never put approve/reject on the step doing the work.
8. branch / ai_step branching: set "branch_on": "<key>", "cases": {"value": "node_id"}, "default": "node_id". If "cases" is present, "default" is REQUIRED.
8b. filter is for "only if / skip unless" — set "source" to a {{steps.…}} reference,
    "operator", and "value". Its "next" runs when the condition holds; omit "on_fail"
    (or set it to null) to end the run quietly when it doesn't. Prefer a filter over a
    branch when one of the two outcomes is simply "do nothing".
9. For an ai_step that feeds a branch, set "output": "json" and a "schema".
10. Every node id referenced in any routing key MUST exist in "steps". Keep it focused: 3-7 nodes.
11. HUMAN-IN-THE-LOOP IS A DECISION, NOT A DEFAULT. Include human_approval before a step that is irreversible or externally visible (posting publicly, emailing OTHER people, opening issues in shared repos) or when the user says draft/review/approve. Omit it when every action is safe/internal/reversible or the user says "automatically / without me". When genuinely uncertain AND an external side effect exists, prefer one approval.
12. CRITICAL DATA RULE: an ai_step can ONLY use data that an EARLIER step produced. An AI model CANNOT see the content of an external app on its own. If the user asks to summarize/rewrite content stored in an app, FIRST add an app_action READ step to fetch it, then have the ai_step reference "{{steps.<read_step_id>.text}}". NEVER write an ai_step that says "summarize the Notion page" without a preceding read step.
13. Typical pattern for "summarize my Shopify orders and post to Slack after I approve":
    manual_trigger_input
      -> app_action "shopify_orders" (SHOPIFY_GET_ORDER_LIST) [reads orders]
      -> ai_step "draft_summary" (output json, instruction references {{steps.shopify_orders.text}}, schema {text})
      -> human_approval
      -> social_post (platform "slack", text "{{steps.draft_summary.result.text}}", options {"channel": "#general"})
13b. Typical event pattern for "reply to Google reviews automatically":
    app_event_trigger (event NEW_GOOGLE_REVIEW, title "New Google Review")
      -> ai_step "categorize_review" (output json, schema {"category": "positive | negative | neutral"},
         instruction references {{steps.new_google_review.event.rating}} and {{steps.new_google_review.event.text}},
         branch_on "category", cases {"positive": "draft_positive", "negative": "draft_negative",
         "neutral": "draft_neutral"}, default "draft_neutral")
      -> EACH branch gets its OWN pair: draft_positive (ai_step, output json, schema {reply})
         -> post_positive (app_action GOOGLEBUSINESS_REPLY_TO_REVIEW,
            {"review_id": "{{steps.new_google_review.event.review_id}}",
             "reply": "{{steps.draft_positive.result.reply}}"}, next: null) — and likewise
         draft_negative -> post_negative, draft_neutral -> post_neutral.
    An event that fires per item processes ONE event per run — never add a read step to
    re-fetch what the trigger already delivers.
13a. A REFERENCE MUST NAME A FIELD THE TARGET STEP ACTUALLY OUTPUTS — see the "OUTPUT"
    line on every node type above. The most common fatal mistake: an ai_step with
    "output": "text" produces ONLY {{steps.<id>.text}}, while an ai_step with
    "output": "json" produces ONLY {{steps.<id>.result}} / {{steps.<id>.result.<schema key>}}.
    Referencing .result on a text step (or .text on a json step) makes the workflow fail
    the moment it runs. Likewise a trigger's data is nested: {{steps.<trigger>.input.topic}},
    {{steps.new_google_review.event.rating}}, {{steps.webhook.body.field}} — never
    {{steps.new_google_review.topic}}.
13d. AN INSTAGRAM POST NEEDS A PICTURE. Instagram will not accept text alone, so a
    social_post with "platform": "instagram" MUST take its "mediaUrl" from an earlier
    generate_image step ("mediaUrl": "{{steps.product_image.url}}"). Add generate_image to any
    other post the user asks to illustrate; describe only the SUBJECT in its "prompt",
    since the brand palette, fonts and product photos are applied automatically.
13e. A VIDEO IS A STEP, NOT AN EXCUSE. When the user asks for a video, a clip, a reel or
    footage, use generate_video and carry it with "mediaUrl": "{{steps.render_clip.url}}" —
    set "mediaKind": "video" for LinkedIn; an instagram social_post with a video mediaUrl
    publishes as a Reel. Never refuse a video, and never substitute an image for one that
    was asked for. Order matters: the
    run PAUSES at generate_video for several minutes while the clip renders, so it goes
    BEFORE any human_approval and before the publish, never between them. Describe only
    the subject in its "prompt" — the brand is applied automatically.
13g. LINKEDIN MEDIA AND LINKS ARE NATIVE, NOT TEXT HACKS. A LinkedIn social_post can set
    "mediaKind" to "image", "video", or "document" and carry the public asset in
    "mediaUrl". "document" means a PDF carousel. For a native gallery, set "mediaKind" to
    "image" and put 2–20 image URLs or {{step}} references on separate lines in "mediaUrls".
    Never combine an image and a video in one post. Use "altText" for a meaningful
    image description, "mediaTitle" for a video/document title, and "thumbnailUrl" for a
    video thumbnail when the request provides one. If the user explicitly asks to include
    a website, put the exact URL they supplied in "websiteUrl" and normally set
    "linkStyle": "soft"; use "direct" only when they ask for a clear call to action, and
    "none" when they ask to omit it. A short "linkLabel" may use their own phrasing. Never
    invent a URL, and do not add the same homepage to every post unless they asked for it.
13c. TEMPLATE REFERENCES ARE SIMPLE PATHS ONLY: {{steps.<id>.<field>...}} — never
    expressions, ternaries, defaults, or logic inside {{ }}. When branches produce
    different data, DO NOT converge them into one shared action step — give each branch
    its own action step referencing its own upstream draft.
14. BE HONEST ABOUT CAPABILITIES — BUT DO NOT OVER-REFUSE.
    You CAN do these things, so never refuse them:
    - PUBLISH to any listed social channel via social_post (posting to LinkedIn, Facebook,
      X, Reddit, Instagram, Slack IS fully supported).
    - REACT to any AVAILABLE TRIGGER event (new Google review, new Shopify order, new
      GitHub issue) — reading the event's fields and acting on them IS fully supported.
    - WRITE/DRAFT any content from scratch with ai_step. A vague request like "post
      something interesting on LinkedIn" is buildable: ai_step drafts the content ->
      human_approval -> social_post. Vagueness is NEVER a reason to refuse — pick a
      sensible interpretation and let the trigger's "fields" collect specifics (e.g. "topic").
    Every app_action MUST use a tool whose app and purpose actually match the data the user
    asked for. NEVER substitute an unrelated tool to fake it (e.g. NEVER fetch calendar
    events when the user asked for LinkedIn data).
    Output an error INSTEAD of a graph ONLY when the request requires READING data that no
    available READ action provides (e.g. LinkedIn post likes/impressions/engagement — LinkedIn's
    API does not expose analytics). In that case output EXACTLY:
    {"error": "<one sentence in product voice: what this automation can't access and the closest thing it CAN do>"}
    The error must describe the automation's limits ("Workflows can't read LinkedIn analytics…"),
    never speak as a chat assistant ("I can help you draft…"), and never ask for more details.

Return the JSON now.`;
}

// ---------------------------------------------------------------------------
// Build + validate
// ---------------------------------------------------------------------------

const MAX_REPAIRS = 2;

export async function buildWorkflow(
  description: string,
  options?: { deadline?: number },
): Promise<BuildOutput> {
  if (!openaiConfigured) {
    const graph = fallbackGraph();
    return toOutput("Sample AI flow", description || "A sample automation (preview mode).", description, graph, true);
  }

  const deadline = options?.deadline;
  // Generated once and reused for every retry below — a repair must never see
  // a catalog different from the one the first attempt was shown, or it can
  // "fix" the JSON into a tool slug that was never on offer.
  const selection = await selectTools(description);
  const prompt = systemPrompt(selection.text);
  const user = `User's automation request:\n${description}`;
  let raw = await ask(prompt, user, deadline);
  let lastErr = "";

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    try {
      const parsed = await normalize(parseJson(raw), selection.specs);
      // A deliberate refusal (unsupported request) — surface it as-is.
      if (typeof parsed.error === "string" && !parsed.steps) {
        throw new BuildRefusal(parsed.error);
      }
      // Fix the references the model got near-miss wrong before judging it —
      // a repair we can make exactly shouldn't cost the user a retry. Same for
      // a target it answered with a stand-in copied out of the catalog: blank
      // it, so the automation arrives honestly "Needs setup" instead of going
      // live pointed at a repository called `<repo>`.
      const { graph } = stripPlaceholders(repairSchedules(repairRefs(graphOf(parsed)).graph));
      validateGraph(graph);
      const name = String(parsed.title ?? "Untitled automation").slice(0, 60);
      const desc = String(parsed.description ?? description).slice(0, 160);
      return toOutput(name, desc, description, graph, false);
    } catch (err) {
      // A dead provider cannot be repaired by asking again — surface it now
      // rather than spending the remaining attempts on a call that must fail.
      if (err instanceof ProviderError) throw err;
      if (err instanceof BuildRefusal) throw new BuildError(err.message);
      lastErr = (err as Error).message;
      if (attempt >= MAX_REPAIRS) break;
      raw = await ask(
        prompt,
        `The previous JSON was invalid: ${lastErr}\nHere is what you produced:\n${raw}\n\nFix it. Output ONLY the corrected JSON object, nothing else.`,
        deadline,
      );
    }
  }
  throw new BuildError(
    `That one didn't come together — try rephrasing with the app and outcome you want (detail: ${lastErr})`,
  );
}

function toOutput(
  name: string,
  desc: string,
  prompt: string,
  graph: WorkflowGraph,
  simulated: boolean,
): BuildOutput {
  const groups = deriveDisplay(graph);
  const config: WorkflowConfig = { v: 1, graph, display: { groups }, prompt };
  return {
    name,
    description: desc,
    config,
    response: buildResponse(name, graph),
    groups,
    simulated,
    requiredApps: requiredAppsOf(graph),
    needsBrand: needsBrandGrounding(graph),
  };
}

async function ask(prompt: string, user: string, deadline?: number): Promise<string> {
  return askWith(prompt, user, 1500, deadline);
}

interface ParsedGraph {
  workflow_id?: string;
  title?: string;
  description?: string;
  start?: string;
  steps?: Record<string, StepDef>;
  /** The model's deliberate "can't do that" channel (rule 14). */
  error?: string;
}

function graphOf(parsed: ParsedGraph): WorkflowGraph {
  return { start: String(parsed.start ?? ""), steps: parsed.steps ?? {} };
}

function parseJson(raw: string): ParsedGraph {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(text) as ParsedGraph;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new BuildError("model response contained no JSON object");
    return JSON.parse(m[0]) as ParsedGraph;
  }
}

/** Flatten LLM-nested config/routing wrappers into flat step keys (idempotent). */
/**
 * @param known Specs already resolved while building the catalog. Every tool
 *   the model could legally emit was just fetched and normalized by
 *   `selectTools`, so consulting that first turns what used to be one
 *   uncached live Composio lookup PER app_action step into zero. It also
 *   closes a real failure mode: a tool shown in the catalog whose live
 *   re-fetch happens to fail would otherwise resolve to nothing here and burn
 *   a repair attempt on a slug that was never wrong.
 */
async function normalize(
  parsed: ParsedGraph,
  known: Record<string, ToolSpec> = {},
): Promise<ParsedGraph> {
  for (const node of Object.values(parsed.steps ?? {})) {
    if (!node || typeof node !== "object") continue;
    for (const wrapper of ["config", "routing", "params", "settings"]) {
      const nested = (node as Record<string, unknown>)[wrapper];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        delete (node as Record<string, unknown>)[wrapper];
        for (const [k, v] of Object.entries(nested as Record<string, unknown>)) {
          if (!(k in node)) (node as Record<string, unknown>)[k] = v;
        }
      }
    }
    // Models sometimes write the tool slug as the node TYPE
    // ({"type": "LINKEDIN_GET_MY_INFO"}). Rewrite to a proper app_action.
    const t = String(node.type ?? "");
    if (!(t in NODE_TYPES)) {
      const resolved = getTool(t, node.tool_spec) ?? known[t] ?? (await findToolSpec(t));
      if (resolved) {
        node.tool = t;
        node.type = "app_action";
        node.tool_spec = resolved;
        if (!node.toolkit) node.toolkit = resolved.app;
      }
    }
    if (node.type === "app_action" && node.tool) {
      const slug = String(node.tool);
      const resolved = getTool(slug, node.tool_spec) ?? known[slug] ?? (await findToolSpec(slug));
      if (resolved) {
        node.tool_spec = resolved;
        if (!node.toolkit) node.toolkit = resolved.app;
      }
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Edit an existing workflow with AI
// ---------------------------------------------------------------------------

/**
 * Tool slugs already used by the graph being edited — always kept in the
 * catalog.
 *
 * An edit instruction describes the CHANGE, not the workflow: "add a Slack
 * message after this" names Slack and nothing else. Retrieval runs on that
 * instruction, so without pinning these the app behind the step being edited
 * ranks nowhere, drops out of the catalog, and the model is asked to preserve
 * a tool it can no longer see.
 */
function toolSlugsOf(graph: WorkflowGraph): string[] {
  const slugs: string[] = [];
  for (const step of Object.values(graph.steps)) {
    if (step.type === "app_action" && typeof step.tool === "string") slugs.push(step.tool);
  }
  return slugs;
}

/** The integrations behind those slugs, so their whole toolkit stays expanded. */
function appsOf(slugs: string[], graph: WorkflowGraph): string[] {
  const apps = new Set<string>();
  for (const step of Object.values(graph.steps)) {
    if (step.type !== "app_action" || typeof step.tool !== "string") continue;
    const spec = getTool(step.tool, step.tool_spec);
    if (spec?.app) apps.add(spec.app);
  }
  // A slug whose spec cannot be resolved still carries its toolkit in its
  // prefix, which is better than losing the app entirely.
  for (const slug of slugs) {
    const prefix = slug.split("_")[0]?.toLowerCase();
    if (prefix && ![...apps].some((a) => a.startsWith(prefix.slice(0, 5)))) apps.add(prefix);
  }
  return [...apps];
}

function editPrompt(toolCatalog: string): string {
  return `You are editing an EXISTING workflow graph in place.

${"You may ONLY use the node types, triggers, app actions and channels listed below."}

${catalogForPrompt()}

AVAILABLE TRIGGERS:
${triggersForPrompt()}

AVAILABLE APP ACTIONS:
${toolCatalog}

EDIT RULES:
1. Output ONLY the complete, corrected workflow JSON in the SAME shape you were given:
   {"title": "...", "description": "...", "start": "...", "steps": {...}}. No commentary.
2. PRESERVE everything the user did not ask you to change — same node ids, same titles,
   same wiring. Node ids appear inside {{steps.<id>.…}} references, so renaming one
   silently breaks downstream steps: only rename when the user asks for it, and then
   update every reference too.
3. If the user asks for a different trigger or describes an automation that requires an event trigger (e.g. new Gmail email),
   replace or update the trigger step with the appropriate trigger from AVAILABLE TRIGGERS (e.g. app_event_trigger)
   and ensure "start" points to it.
4. When adding steps:
   - Use filter or ai_step (with "output": "json", schema, and branch_on) to evaluate conditions (such as checking if action is required or if email is important).
   - Use social_post (platform "slack") to post messages to Slack.
   - Use app_action for tool actions from the catalog.
5. Keep the graph valid: exactly one trigger and it must be the start node, every
   routing target must exist, at least one path must terminate, and every
   {{steps.<id>.<field>}} reference must point at a step that runs EARLIER.
6. When adding a step, wire it into the chain — set its "next" and re-point whatever
   used to lead to its position.
7. Same {{ }} rules as the compiler: simple dotted paths only, never expressions.
8. Output an error ONLY when the request requires data or actions completely unsupported by the available catalog.
   If the request can be achieved using available triggers (e.g. NEW_GMAIL_EMAIL), ai_step/filter, and actions (e.g. Slack),
   ALWAYS output the complete JSON graph.

Return the JSON now.`;
}

export interface EditOutput {
  graph: WorkflowGraph;
  name: string;
  description: string;
  response: ResponseSegment[][];
  groups: WorkflowGroup[];
  requiredApps: RequiredApp[];
  needsBrand: boolean;
}

/**
 * Apply a plain-English change to an existing graph. Used by the chat panel on
 * the editor page, so "add a Slack notification at the end" and dragging a
 * Slack block onto the canvas produce the same result — both land as an
 * ordinary graph the user can keep editing by hand.
 */
export async function editWorkflow(
  current: { name: string; description: string; graph: WorkflowGraph },
  instruction: string,
): Promise<EditOutput> {
  if (!openaiConfigured) {
    throw new BuildError(
      "AI editing needs an OpenAI key — you can still change every step by hand in the editor.",
    );
  }

  // Computed once and reused for the retry below, same reasoning as the
  // build path: existing GitHub steps must stay visible to the model across
  // every attempt, not just the first.
  const keepSlugs = toolSlugsOf(current.graph);
  const selection = await selectTools(instruction, {
    keepSlugs,
    keepApps: appsOf(keepSlugs, current.graph),
  });
  const prompt = editPrompt(selection.text);

  const payload = JSON.stringify(
    { title: current.name, description: current.description, start: current.graph.start, steps: current.graph.steps },
    null,
    1,
  );
  let raw = await askWith(
    prompt,
    `Current workflow:\n${payload}\n\nRequested change:\n${instruction}`,
  );
  let lastErr = "";

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    try {
      const parsed = await normalize(parseJson(raw), selection.specs);
      if (typeof parsed.error === "string" && !parsed.steps) {
        throw new BuildRefusal(parsed.error);
      }
      // Same two deterministic repairs as the build path: an edit is model
      // output too, and can reintroduce either mistake.
      const { graph } = stripPlaceholders(repairSchedules(repairRefs(graphOf(parsed)).graph));
      validateGraph(graph);
      const name = String(parsed.title ?? current.name).slice(0, 60);
      const description = String(parsed.description ?? current.description).slice(0, 200);
      return {
        graph,
        name,
        description,
        response: editResponse(current.graph, graph),
        groups: deriveDisplay(graph),
        requiredApps: requiredAppsOf(graph),
        needsBrand: needsBrandGrounding(graph),
      };
    } catch (err) {
      // A dead provider cannot be repaired by asking again — surface it now
      // rather than spending the remaining attempts on a call that must fail.
      if (err instanceof ProviderError) throw err;
      if (err instanceof BuildRefusal) throw new BuildError(err.message);
      lastErr = (err as Error).message;
      if (attempt >= MAX_REPAIRS) break;
      raw = await askWith(
        prompt,
        `The previous JSON was invalid: ${lastErr}\nHere is what you produced:\n${raw}\n\nFix it. Output ONLY the corrected JSON object, nothing else.`,
      );
    }
  }
  throw new BuildError(`I couldn't apply that change (detail: ${lastErr})`);
}

/**
 * One call to the compiler model. Provider failures are translated here so
 * every caller reports them the same way — and so the repair loops can tell a
 * bad graph (retry) from a dead provider (stop).
 */
async function askWith(
  system: string,
  user: string,
  maxTokens = 2000,
  deadline?: number,
): Promise<string> {
  try {
    return await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { json: true, maxTokens, temperature: 0.2, timeoutMs: remainingBuildTime(deadline) },
    );
  } catch (err) {
    const provider = providerError(err);
    if (provider) throw provider;
    throw err;
  }
}

function remainingBuildTime(deadline?: number): number | undefined {
  if (deadline === undefined) return undefined;
  const remaining = deadline - Date.now();
  if (remaining <= 1_000) {
    throw Object.assign(new Error("Workflow build deadline elapsed"), { name: "TimeoutError" });
  }
  // Leave room for persistence/refund work and never let one provider call
  // consume the whole job lease. Repair calls receive the newly remaining time.
  return Math.min(remaining - 1_000, 45_000);
}

/** Describe an edit as a diff of step ids — concrete, and never overstated. */
function editResponse(before: WorkflowGraph, after: WorkflowGraph): ResponseSegment[][] {
  const beforeIds = new Set(Object.keys(before.steps));
  const afterIds = new Set(Object.keys(after.steps));
  const added = [...afterIds].filter((id) => !beforeIds.has(id));
  const removed = [...beforeIds].filter((id) => !afterIds.has(id));
  const changed = [...afterIds].filter(
    (id) => beforeIds.has(id) && JSON.stringify(before.steps[id]) !== JSON.stringify(after.steps[id]),
  );

  const name = (graph: WorkflowGraph, id: string) => String(graph.steps[id]?.title ?? id);
  const lines: ResponseSegment[][] = [];
  if (added.length) {
    lines.push([{ t: "Added " }, { t: added.map((id) => name(after, id)).join(", "), b: true }, { t: "." }]);
  }
  if (removed.length) {
    lines.push([{ t: "Removed " }, { t: removed.map((id) => name(before, id)).join(", "), b: true }, { t: "." }]);
  }
  if (changed.length) {
    lines.push([{ t: "Updated " }, { t: changed.map((id) => name(after, id)).join(", "), b: true }, { t: "." }]);
  }
  if (!lines.length) lines.push([{ t: "That was already how the workflow was set up — nothing changed." }]);
  lines.push([{ t: "Review it on the canvas, then press Save to keep it." }]);
  return lines;
}

/** Deterministic sample used when no LLM key is present. */
function fallbackGraph(): WorkflowGraph {
  return {
    start: "start",
    steps: {
      start: { type: "manual_trigger_input", title: "Run manually", stage: "Trigger", fields: ["text"], next: "process" },
      process: {
        type: "ai_step",
        title: "Summarize the input",
        stage: "Process",
        instruction: "Summarize the input text in one sentence.",
        output: "text",
        next: "review",
      },
      review: {
        type: "human_approval",
        title: "Review & approve",
        stage: "Review",
        prompt: "Approve the AI output?",
        on_approve: "done",
        on_reject: "stop",
      },
      done: { type: "log_action", title: "Publish", stage: "Finish", label: "publish", message: "Published: {{steps.process.text}}", next: null },
      stop: { type: "log_action", title: "Discard", stage: "Finish", label: "discarded", message: "Rejected by human.", next: null },
    },
  };
}
