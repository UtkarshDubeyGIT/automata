import { getEdge } from "./graph";
import { getTool } from "./registry";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * Where the words are going — told to the model that writes them.
 *
 * An `ai_step` used to know the instruction, the upstream data and the brand,
 * and nothing whatsoever about the destination. So the same node wrote the
 * same paragraph whether it was about to become a LinkedIn post, a tweet, a
 * Slack message or the body of an email — and it wrote it the way a language
 * model writes prose when nobody says otherwise: with a bolded title line,
 * markdown headings, and a length owing more to the model's habits than to
 * anything the channel accepts. A "**Key takeaways:**" heading published to
 * LinkedIn is not a formatting nit; it is the tell that nothing was written
 * for LinkedIn.
 *
 * The graph has known the answer the whole time — it is the step two hops
 * along — so this walks forward to the first thing that actually SENDS and
 * describes it in the words the writer needs.
 *
 * Pure and dependency-light on purpose (`graph.ts` + `registry.ts`, nothing
 * that reaches a provider or a database): the engine calls it per AI step, on
 * the graph the run is replaying against.
 */

/** How far to look before deciding nothing publishes this. */
const MAX_HOPS = 8;

export interface Destination {
  /** Social platform slug when it is a post, else null. */
  platform: string | null;
  /** "LinkedIn", "a Slack channel", "an email" — for the prompt's first line. */
  label: string;
  /** The conventions of that place, stated as instructions. */
  brief: string;
}

/**
 * What each channel actually accepts.
 *
 * Hard limits are facts and are stated as facts. Everything else is kept to
 * the conventions a reader would notice immediately if they were broken —
 * this is a nudge toward the right shape, not a house style, and the brand's
 * own voice (which arrives in the same prompt, and is authoritative) has to
 * survive it.
 */
const CHANNEL_BRIEF: Record<string, string> = {
  linkedin:
    "Write it as a LinkedIn post: first person, plain sentences, short paragraphs " +
    "separated by blank lines. Only the first ~200 characters show before “see more”, " +
    "so the opening line has to carry it. Hard limit 3,000 characters; aim well under. " +
    "No markdown, no headings, no bold, no bullet characters, no title line.",
  twitter:
    "Write it as a single post on X: 280 characters maximum, one idea, no thread, " +
    "no markdown, no headings. Hashtags only if the brand voice already uses them.",
  facebook:
    "Write it as a Facebook post: conversational, short paragraphs, no markdown and " +
    "no headings.",
  instagram:
    "Write it as an Instagram caption for the image or clip this post carries: it is " +
    "read UNDER the media, so it must not describe the media. 2,200 characters " +
    "maximum, no markdown, no headings.",
  reddit:
    "Write it as the body of a Reddit post: plain, direct, no marketing voice, no " +
    "emoji, and no headings. Reddit punishes anything that reads as an advertisement.",
  slack:
    "Write it as a Slack message: short, direct, a colleague talking to colleagues. " +
    "No headings, no sign-off, no subject line.",
};

/**
 * Channels whose posts are read by an audience, rather than by colleagues.
 *
 * The distinction only exists for one house-style rule: "end on a question"
 * is right for a LinkedIn post and wrong for a Slack message, an email body or
 * an operational WhatsApp alert. Slack is deliberately absent even though it
 * has a CHANNEL_BRIEF entry — its brief already says "a colleague talking to
 * colleagues", and colleagues do not get asked to engage.
 */
const AUDIENCE_CHANNELS = new Set(["linkedin", "twitter", "facebook", "instagram", "reddit"]);

/** Takes a bare slug so a `social_post` step can ask without building a Destination. */
export function writesForAnAudience(platform: string | null | undefined): boolean {
  return !!platform && AUDIENCE_CHANNELS.has(platform);
}

/** Anything that sends. A read fetches, so nothing is being written for it. */
function isDelivery(step: StepDef): boolean {
  if (step.type === "social_post") return true;
  if (step.type !== "app_action") return false;
  return getTool(String(step.tool ?? ""), step.tool_spec)?.kind !== "read";
}

export function destinationOf(
  graph: WorkflowGraph | null | undefined,
  stepId: string,
): Destination | null {
  const start = graph?.steps?.[stepId];
  if (!graph || !start) return null;

  // An approval sits BETWEEN the draft and the post more often than not, so
  // following `on_approve` is what makes this work for the shape most of these
  // automations actually have. A branch is where it stops: which way a run
  // goes is decided by data this step is about to produce, so any destination
  // past it would be a guess, and a wrong one is worse than none.
  let cursor = getEdge(start, "next") ?? getEdge(start, "on_approve");
  const seen = new Set<string>([stepId]);
  let hops = 0;

  while (cursor && !seen.has(cursor) && hops++ < MAX_HOPS) {
    seen.add(cursor);
    const step: StepDef | undefined = graph.steps[cursor];
    if (!step) return null;
    if (step.type === "branch" || step.type === "filter") return null;
    if (isDelivery(step)) return describe(step);
    cursor = getEdge(step, "next") ?? getEdge(step, "on_approve");
  }
  return null;
}

function describe(step: StepDef): Destination | null {
  if (step.type === "social_post") {
    const platform = String(step.platform ?? "").trim();
    const brief = CHANNEL_BRIEF[platform];
    if (!platform || !brief) return null;
    const options = (step.options as Record<string, unknown>) ?? {};
    // Where inside the channel, when the channel has an inside. A subreddit is
    // a different room from LinkedIn with different manners, and naming it is
    // most of what makes a Reddit post survive contact with Reddit.
    const where =
      platform === "reddit" && typeof options.subreddit === "string" && options.subreddit.trim()
        ? ` (r/${options.subreddit.trim().replace(/^r\//, "")})`
        : platform === "slack" && typeof options.channel === "string" && options.channel.trim()
          ? ` (${options.channel.trim()})`
          : "";
    return {
      platform,
      label: `${LABEL[platform] ?? platform}${where}`,
      brief,
    };
  }

  // An app action that sends. The tool registry already describes it in the
  // words the compiler uses, which is exactly the sentence wanted here.
  const spec = getTool(String(step.tool ?? ""), step.tool_spec);
  if (!spec) return null;
  const email = /email|mail/i.test(spec.app) || /email/i.test(spec.desc);
  return {
    platform: null,
    label: spec.desc,
    brief: email
      ? "This is the body of an email. Plain sentences and short paragraphs; no " +
        "markdown, no headings, and do not write a subject line — another field carries it."
      : `This text is sent straight to ${spec.app} by the next step, so write only the ` +
        "content itself — no preamble, no markdown, no headings.",
  };
}

/** Channel names as a person writes them, not as a slug. */
const LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  twitter: "X",
  facebook: "Facebook",
  instagram: "Instagram",
  reddit: "Reddit",
  slack: "Slack",
};
