export type ResourceKind =
  | "slack_channel"
  | "google_calendar"
  | "ga4_property"
  | "business_location"
  | "search_console_site"
  | "linear_team"
  | "linear_project"
  | "linkedin_organization";

export const RESOURCE_KINDS: ResourceKind[] = [
  "slack_channel", "google_calendar", "ga4_property", "business_location",
  "search_console_site", "linear_team", "linear_project", "linkedin_organization",
];

export interface ResourceBinding {
  kind: ResourceKind;
  format?: "organization_urn";
}

/** Only explicit bindings are rendered as provider choices. */
const TRIGGER_RESOURCES: Record<string, Record<string, ResourceBinding>> = {
  NEW_SLACK_MESSAGE: { watch_channel: { kind: "slack_channel" } },
  NEW_CALENDAR_EVENT: { watch_calendarId: { kind: "google_calendar" } },
  NEW_LINEAR_ISSUE: {
    watch_team_id: { kind: "linear_team" },
    watch_project_id: { kind: "linear_project" },
  },
  NEW_GOOGLE_REVIEW: { watch_location: { kind: "business_location" } },
};

const ACTION_RESOURCES: Record<string, Record<string, ResourceBinding>> = {
  SLACK_FETCH_CONVERSATION_HISTORY: { channel: { kind: "slack_channel" } },
  SLACK_ADD_REACTION_TO_AN_ITEM: { channel: { kind: "slack_channel" } },
  GOOGLECALENDAR_EVENTS_LIST: { calendarId: { kind: "google_calendar" }, calendar_id: { kind: "google_calendar" } },
  GOOGLECALENDAR_DELETE_EVENT: { calendar_id: { kind: "google_calendar" } },
  GOOGLE_ANALYTICS_RUN_REPORT: { property: { kind: "ga4_property" } },
  GOOGLEBUSINESS_GET_PERFORMANCE_REPORT: { location: { kind: "business_location" } },
  GOOGLEBUSINESS_GET_REVIEWS: { location: { kind: "business_location" } },
  GOOGLEBUSINESS_REPLY_TO_REVIEW: { location: { kind: "business_location" } },
  GOOGLE_SEARCH_CONSOLE_SEARCH_ANALYTICS_QUERY: { site_url: { kind: "search_console_site" } },
  GOOGLE_SEARCH_CONSOLE_INSPECT_URL: { site_url: { kind: "search_console_site" } },
  GOOGLE_SEARCH_CONSOLE_SUBMIT_SITEMAP: { site_url: { kind: "search_console_site" } },
  LINKEDIN_GET_SHARE_STATS: { organizational_entity: { kind: "linkedin_organization", format: "organization_urn" } },
  LINKEDIN_GET_ORG_PAGE_STATS: { organization: { kind: "linkedin_organization", format: "organization_urn" } },
  LINKEDIN_GET_NETWORK_SIZE: { organization_id: { kind: "linkedin_organization" } },
};

export function triggerResource(event: string, key: string): ResourceBinding | undefined {
  return TRIGGER_RESOURCES[event]?.[key];
}

export function actionResource(tool: string, key: string): ResourceBinding | undefined {
  return ACTION_RESOURCES[tool]?.[key];
}

export function actionResourceEntries(tool: string, spec?: { inputSchema?: Record<string, unknown>; argHint?: string }, values?: Record<string, unknown>): Array<[string, ResourceBinding]> {
  const entries = Object.entries(ACTION_RESOURCES[tool] ?? {});
  if (tool !== "GOOGLECALENDAR_EVENTS_LIST") return entries;
  const properties = spec?.inputSchema?.properties;
  const schema = properties && typeof properties === "object" ? properties as Record<string, unknown> : {};
  const key = (values && "calendarId" in values && !("calendar_id" in values)) || "calendarId" in schema || spec?.argHint?.includes('"calendarId"')
    ? "calendarId"
    : "calendar_id";
  return entries.filter(([candidate]) => candidate === key);
}

export function resourceValue(binding: ResourceBinding, id: string): string {
  return binding.format === "organization_urn" && id
    ? `urn:li:organization:${selectedResourceId(binding, id)}`
    : id;
}

export function selectedResourceId(binding: ResourceBinding, value: string): string {
  return binding.format === "organization_urn"
    ? value.replace(/^urn:li:organization:/i, "")
    : value;
}
