import type { StepDef, WorkflowGraph } from "./types";

/** A workflow capability that is visible in the product but cannot run yet. */
export interface ComingSoonFeature {
  id:
    | "x_publishing"
    | "tiktok_publishing"
    | "linkedin_company_publishing"
    | "meta_ads_actions"
    | "google_ads_reports"
    | "whatsapp_sends";
  label: string;
  message: string;
}

const FEATURES: Record<ComingSoonFeature["id"], ComingSoonFeature> = {
  x_publishing: {
    id: "x_publishing",
    label: "X publishing",
    message: "X publishing is coming soon.",
  },
  tiktok_publishing: {
    id: "tiktok_publishing",
    label: "TikTok publishing",
    message: "TikTok publishing is coming soon.",
  },
  linkedin_company_publishing: {
    id: "linkedin_company_publishing",
    label: "LinkedIn company-page publishing",
    message: "LinkedIn company-page publishing is coming soon. Personal-page posts are available.",
  },
  meta_ads_actions: {
    id: "meta_ads_actions",
    label: "Meta Ads actions",
    message: "Meta Ads workflow actions are coming soon.",
  },
  google_ads_reports: {
    id: "google_ads_reports",
    label: "Google Ads reports",
    message: "Google Ads reports are coming soon.",
  },
  whatsapp_sends: {
    id: "whatsapp_sends",
    label: "WhatsApp workflow sends",
    message: "WhatsApp workflow sends are coming soon.",
  },
};

/** Shared AI instruction: keep the compiler from presenting blocked work as buildable. */
export const COMING_SOON_AI_POLICY = `UNAVAILABLE WORKFLOW CAPABILITIES (Coming soon — never emit these steps, even if a matching tool appears below):
- ${FEATURES.x_publishing.message}
- ${FEATURES.tiktok_publishing.message}
- ${FEATURES.linkedin_company_publishing.message} LinkedIn personal-page posts remain available; do not use a company pageId.
- ${FEATURES.meta_ads_actions.message}
- ${FEATURES.google_ads_reports.message}
- ${FEATURES.whatsapp_sends.message} WhatsApp read actions remain available.
If the user's request requires one of these capabilities, return only {"error":"<the matching Coming soon message>"} and do not substitute a different action.`;

const NON_EMPTY = (value: unknown) => typeof value === "string" && value.trim().length > 0;

function appActionFeature(step: StepDef): ComingSoonFeature | null {
  const slug = typeof step.tool === "string" ? step.tool.toUpperCase() : "";
  const rawSpec = step.tool_spec && typeof step.tool_spec === "object" && !Array.isArray(step.tool_spec)
    ? step.tool_spec as Record<string, unknown>
    : {};
  const app = String(step.toolkit ?? rawSpec.app ?? "").toLowerCase();
  const kind = rawSpec.kind === "write" || rawSpec.kind === "read" ? rawSpec.kind : undefined;

  if (app === "metaads" || slug.startsWith("METAADS_")) return FEATURES.meta_ads_actions;
  if (slug === "GOOGLEADS_GET_REPORT") return FEATURES.google_ads_reports;
  if ((app === "twitter" || app === "x") && (kind === "write" || /^(TWITTER|X)_(CREATE|POST|PUBLISH|UPLOAD)/.test(slug))) return FEATURES.x_publishing;
  if (app === "tiktok" && (kind === "write" || /^TIKTOK_(CREATE|POST|PUBLISH|UPLOAD)/.test(slug))) return FEATURES.tiktok_publishing;
  if (app === "whatsapp" && (kind === "write" || slug.startsWith("WHATSAPP_SEND_"))) {
    return FEATURES.whatsapp_sends;
  }

  // `social_post` is the supported path for member posts. These two generic
  // LinkedIn writes accept either a member or an organization as `author`; an
  // unresolved author is ambiguous, so only an explicit person URN stays live.
  if (app === "linkedin" && ["LINKEDIN_CREATE_LINKED_IN_POST", "LINKEDIN_CREATE_ARTICLE_OR_URL_SHARE"].includes(slug)) {
    const args = step.arguments;
    const author = args && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>).author
      : undefined;
    if (typeof author === "string" && /^urn:li:person:/i.test(author.trim())) return null;
    return FEATURES.linkedin_company_publishing;
  }
  return null;
}

/** Return the Coming soon capability for a workflow step, if it has one. */
export function comingSoonForStep(step: StepDef): ComingSoonFeature | null {
  if (!step || typeof step !== "object") return null;
  if (step.type === "social_post") {
    const platform = String(step.platform ?? "").toLowerCase();
    if (platform === "twitter" || platform === "x") return FEATURES.x_publishing;
    if (platform === "tiktok") return FEATURES.tiktok_publishing;
    if (platform === "linkedin") {
      const options = step.options && typeof step.options === "object" && !Array.isArray(step.options)
        ? step.options as Record<string, unknown>
        : {};
      if (NON_EMPTY(options.pageId) || NON_EMPTY(options.page_id)) {
        return FEATURES.linkedin_company_publishing;
      }
    }
  }
  if (step.type === "whatsapp_reminder") return FEATURES.whatsapp_sends;
  if (step.type === "app_action") return appActionFeature(step);
  return null;
}

/** Capabilities used by a graph, deduplicated in first-use order. */
export function comingSoonFeaturesForGraph(graph: WorkflowGraph | null | undefined): ComingSoonFeature[] {
  if (!graph?.steps || typeof graph.steps !== "object") return [];
  const found = new Map<ComingSoonFeature["id"], ComingSoonFeature>();
  for (const step of Object.values(graph.steps)) {
    const feature = comingSoonForStep(step);
    if (feature) found.set(feature.id, feature);
  }
  return [...found.values()];
}

/** Block newly introduced unavailable nodes while allowing legacy drafts to be edited or reduced. */
export function comingSoonStepsAddedSince(
  graph: WorkflowGraph,
  previous: WorkflowGraph | null | undefined,
): ComingSoonFeature[] {
  const additions = new Map<ComingSoonFeature["id"], ComingSoonFeature>();
  for (const [stepId, step] of Object.entries(graph.steps ?? {})) {
    const feature = comingSoonForStep(step);
    if (!feature) continue;
    const prior = previous?.steps?.[stepId];
    if (prior && comingSoonForStep(prior)?.id === feature.id) continue;
    additions.set(feature.id, feature);
  }
  return [...additions.values()];
}

/** Integration cards use the same capability labels as the workflow editor. */
export function comingSoonForIntegration(slug: string): ComingSoonFeature | null {
  switch (slug.toLowerCase().replace(/[- ]/g, "_")) {
    case "twitter":
    case "x":
      return FEATURES.x_publishing;
    case "tiktok":
      return FEATURES.tiktok_publishing;
    case "linkedin":
    case "linkedin_pages":
      return FEATURES.linkedin_company_publishing;
    case "metaads":
    case "meta_ads":
      return FEATURES.meta_ads_actions;
    case "googleads":
    case "google_ads":
      return FEATURES.google_ads_reports;
    case "whatsapp":
      return FEATURES.whatsapp_sends;
    default:
      return null;
  }
}
