import type { ResourceKind } from "./resources";

export interface ResourceChoice {
  value: string;
  label: string;
  secondary?: string;
}

export type PickerStatus = "loading" | "disconnected" | "failed" | "empty" | "stale" | "ready";

export function pickerStatus(state: {
  loading: boolean;
  error: string;
  disconnected: boolean;
  choices: ResourceChoice[];
  selected: string;
  nextCursor: string | null;
  extraChoices?: Array<{ value: string }>;
}): PickerStatus {
  if (state.loading) return "loading";
  if (state.error) return state.disconnected ? "disconnected" : "failed";
  if (state.selected && !state.nextCursor &&
      !state.choices.some((choice) => choice.value === state.selected) &&
      !state.extraChoices?.some((choice) => choice.value === state.selected)) return "stale";
  if (!state.choices.length && !state.nextCursor && !state.extraChoices?.length) return "empty";
  return "ready";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function entries(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function choice(value: unknown, label: unknown, secondary?: unknown): ResourceChoice | null {
  const id = String(value ?? "").trim();
  if (!id) return null;
  const name = String(label ?? "").trim() || id;
  return { value: id, label: name, ...(secondary ? { secondary: String(secondary) } : {}) };
}

export function normalizeResourceChoices(kind: ResourceKind, body: unknown): ResourceChoice[] {
  const data = record(body);
  const errors = entries(data.errors);
  if (errors.length) throw new Error(String(errors[0].message ?? "Provider lookup failed."));
  let result: Array<ResourceChoice | null> = [];
  switch (kind) {
    case "ga4_property":
      result = entries(data.accountSummaries).flatMap((account) =>
        entries(account.propertySummaries).map((property) =>
          choice(property.property, property.displayName, account.displayName)));
      break;
    case "google_calendar":
      result = entries(data.items).map((item) => choice(item.id, item.summaryOverride ?? item.summary));
      break;
    case "business_location":
      result = entries(data.locations).map((location) => choice(location.name, location.title));
      break;
    case "search_console_site":
      result = entries(data.siteEntry).map((site) => choice(site.siteUrl, site.siteUrl));
      break;
    case "linear_team":
    case "linear_project": {
      const group = kind === "linear_team" ? "teams" : "projects";
      if (!Array.isArray(record(record(data.data)[group]).nodes)) {
        throw new Error("Linear returned an unreadable resource list. Try again.");
      }
      result = entries(record(record(data.data)[group]).nodes).map((item) => choice(item.id, item.name));
      break;
    }
    case "slack_channel":
      result = entries(data.channels).map((channel) =>
        choice(channel.id, `${channel.private ? "Private: " : "#"}${String(channel.name ?? channel.id)}`));
      break;
    case "linkedin_organization":
      result = entries(data.pages).map((page) => choice(page.id, page.name));
      break;
  }
  const seen = new Set<string>();
  return result.filter((item): item is ResourceChoice => {
    if (!item || seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}
