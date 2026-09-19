/**
 * Labelled prompts for measuring stage-1 integration retrieval.
 *
 * This fixture is the yardstick the whole retrieval pipeline is judged
 * against — `scripts/eval-retrieval.ts` scores lexical-only, dense-only and
 * the Tool-to-Agent roll-up on it, and the plan's ship/no-ship threshold
 * (recall@20 >= 0.9) is measured here. It exists BEFORE the retriever on
 * purpose: a retriever tuned against a fixture written afterwards only proves
 * it can fit the cases its author already had in mind.
 *
 * `expect` lists every integration the request genuinely needs. Recall for a
 * case is |retrieved ∩ expect| / |expect|, so a two-app request scores 0.5
 * when only one side is found — a workflow that can post to Slack but cannot
 * read the thing it is summarising is not half-right, and the metric should
 * say so.
 */

/**
 * Case kinds, because an aggregate recall number hides the thing worth
 * knowing. Lexical matching should dominate `named`; if dense retrieval earns
 * its cost anywhere it is `vocabulary`, where the request shares no words
 * with the integration at all. Reporting only the mean lets a retriever look
 * adequate while being useless at the half that motivated the work.
 */
export type CaseKind = "native" | "vocabulary" | "named" | "multi" | "adversarial";

export interface RetrievalCase {
  prompt: string;
  /** Integration slugs that must all appear in the retrieved set. */
  expect: string[];
  kind: CaseKind;
  /** Why this case earns its place — what it would catch if it regressed. */
  note: string;
}

export const RETRIEVAL_CASES: RetrievalCase[] = [
  // --- Native-only apps. Composio 404s on these slugs, so they can only ever
  // arrive via the force-include from our own registry. If the force-include
  // regresses, these are the cases that fail. ------------------------------
  {
    prompt: "set up a summary for Dr. Gulshan Business for rolling 30 days and send on slack",
    expect: ["googlebusinessprofile", "slack"],
    kind: "native",
    note: "the request that started this work; googlebusinessprofile is native-only (Composio 404s it)",
  },
  {
    prompt: "when someone leaves a new Google review, draft a reply and let me approve it first",
    expect: ["googlebusinessprofile"],
    kind: "native",
    note: "native-only app reached by event vocabulary rather than by app name",
  },
  {
    prompt: "add a task to my Vikunja project whenever a customer emails support",
    expect: ["vikunja", "gmail"],
    kind: "native",
    note: "vikunja is native-only and also absent from Composio",
  },

  // --- Vocabulary mismatch: the integration's own blurb does not contain the
  // request's words, but one of its TOOLS does. These are the cases that
  // separate the Tool-to-Agent roll-up from ranking integration blurbs. -----
  {
    prompt: "every Monday post a message in our team channel with last week's numbers",
    expect: ["slack"],
    kind: "vocabulary",
    note: "says 'team channel', never 'Slack'",
  },
  {
    prompt: "when a deal moves to closed won, add the company to our mailing list",
    expect: ["hubspot", "mailchimp"],
    kind: "vocabulary",
    note: "CRM stage vocabulary; no app named",
  },
  {
    prompt: "file a ticket for every crash report that comes into the inbox",
    expect: ["linear", "gmail"],
    kind: "vocabulary",
    note: "'ticket' vs Linear's issue vocabulary",
  },
  {
    prompt: "book a 30 minute call with anyone who fills in the contact form",
    expect: ["calendly", "typeform"],
    kind: "vocabulary",
    note: "scheduling and form vocabulary, no product names",
  },
  {
    prompt: "when a payment fails, notify the account owner and flag the subscription",
    expect: ["stripe"],
    kind: "vocabulary",
    note: "billing-event vocabulary; Stripe's blurb is generic 'payments infrastructure'",
  },

  // --- Plainly named apps. These should be easy; if they fail, something is
  // badly wrong rather than subtly mistuned. --------------------------------
  {
    prompt: "create a GitHub issue when a Sentry alert fires",
    expect: ["github"],
    kind: "named",
    note: "baseline — app named outright",
  },
  {
    prompt: "save every new Shopify order to a Google Sheet",
    expect: ["shopify", "googlesheets"],
    kind: "named",
    note: "baseline two-app, both named",
  },
  {
    prompt: "post a summary of yesterday's Notion updates to Discord",
    expect: ["notion", "discord"],
    kind: "named",
    note: "baseline two-app, both named",
  },
  {
    prompt: "every morning email me my Google Calendar agenda for the day",
    expect: ["googlecalendar", "gmail"],
    kind: "named",
    note: "baseline; two Google products that must not collapse into one",
  },

  // --- Multi-app chains. The retrieved set has to hold all of them, which is
  // where a too-narrow K shows up first. ------------------------------------
  {
    prompt:
      "when a new row is added to Airtable, create a Trello card and tell the team on Slack",
    expect: ["airtable", "trello", "slack"],
    kind: "multi",
    note: "three apps in one request",
  },
  {
    prompt:
      "summarise new Zendesk tickets each afternoon and drop the digest in a Google Doc",
    expect: ["zendesk", "googledrive"],
    kind: "multi",
    note: "Google Docs lives under the googledrive toolkit, not its own",
  },
  {
    prompt: "when a Jira epic is completed, update the Salesforce opportunity and post to Slack",
    expect: ["jira", "salesforce", "slack"],
    kind: "multi",
    note: "three apps, enterprise vocabulary",
  },

  // --- Requests that name no app at all. The retriever has to infer the
  // category from the described outcome. ------------------------------------
  {
    prompt: "remind me to follow up with leads that have gone quiet for two weeks",
    expect: ["hubspot"],
    kind: "vocabulary",
    note: "pure outcome description, no app, no event vocabulary",
  },
  {
    prompt: "collect customer feedback after every support conversation closes",
    expect: ["intercom"],
    kind: "vocabulary",
    note: "no app named; support-conversation vocabulary",
  },
  {
    prompt: "back up our uploaded files somewhere safe once a week",
    expect: ["dropbox"],
    kind: "vocabulary",
    note: "storage intent with no product name",
  },

  // --- Adversarial: prompts that previously flooded the catalog with GitHub
  // because of generic verbs. GitHub must NOT be required here; these are
  // scored for precision damage, not recall. --------------------------------
  {
    prompt: "set up a weekly report and send it out to the team",
    expect: ["slack"],
    kind: "adversarial",
    note: "'set' alone used to pull 56 GitHub tools; guards the original defect",
  },
  {
    prompt: "create a new record and update the status when it changes",
    expect: [],
    kind: "adversarial",
    note: "deliberately contentless — scored only for what it must NOT surface",
  },
];

/**
 * Integrations an adversarial case must not surface. Kept separate from
 * `expect` because these are precision assertions: the case has no right
 * answer, only wrong ones.
 */
export const MUST_NOT_SURFACE: Record<string, string[]> = {
  "set up a weekly report and send it out to the team": ["github"],
  "create a new record and update the status when it changes": ["github"],
};

/** Edit-flow cases: the instruction never names the app already in the graph. */
export interface EditRetrievalCase {
  instruction: string;
  /** Tool slugs already present in the workflow being edited. */
  existingTools: string[];
  expect: string[];
  note: string;
}

export const EDIT_CASES: EditRetrievalCase[] = [
  {
    instruction: "add a Slack message after this",
    existingTools: ["GITHUB_CREATE_AN_ISSUE"],
    expect: ["github", "slack"],
    note: "github appears nowhere in the instruction; only the existing graph knows about it",
  },
  {
    instruction: "also ask me to approve it before it goes out",
    existingTools: ["GOOGLEBUSINESS_REPLY_TO_REVIEW"],
    expect: ["googlebusinessprofile"],
    note: "instruction names no app at all, and the existing one is native-only",
  },
];
