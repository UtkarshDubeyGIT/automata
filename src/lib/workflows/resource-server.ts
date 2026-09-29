import "server-only";

import { businessLocations } from "@/lib/google/business-profile";
import { composioConfigured, env } from "@/lib/env";
import { connectedAccountIds, proxyFor } from "@/lib/social/composio-proxy";
import { linkedinCompanyPages, slackChannelPage } from "@/lib/social/composio";
import { normalizeResourceChoices, type ResourceChoice } from "./resource-options";
import type { ResourceKind } from "./resources";

export class ResourceLookupError extends Error {
  status: 409 | 502;
  constructor(message: string, status: 409 | 502 = 502) {
    super(message);
    this.status = status;
  }
}

export interface ResourcePage {
  choices: ResourceChoice[];
  nextCursor: string | null;
}

const TOOLKIT: Partial<Record<ResourceKind, string>> = {
  slack_channel: "slack",
  google_calendar: "googlecalendar",
  ga4_property: "google_analytics",
  search_console_site: "google_search_console",
  linear_team: "linear",
  linear_project: "linear",
  linkedin_organization: "linkedin",
};

async function providerResponse(
  workspaceId: string,
  toolkit: string,
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
  parameters?: Array<{ name: string; value: string; type: "header" | "query" }>,
): Promise<Record<string, unknown>> {
  const response = await proxyFor<Record<string, unknown>>(workspaceId, toolkit, { endpoint, method, body, parameters });
  if (!response) throw new ResourceLookupError(`Connect ${toolkit} to choose an option.`, 409);
  if (response.status < 200 || response.status >= 300) {
    throw new ResourceLookupError(`Could not load choices from ${toolkit}. Try again.`);
  }
  if (!response.data || typeof response.data !== "object" || Array.isArray(response.data)) {
    throw new ResourceLookupError(`${toolkit} returned an unreadable resource list. Try again.`);
  }
  return response.data;
}

function pageToken(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

export async function listResourcePage(
  workspaceId: string,
  kind: ResourceKind,
  cursor = "",
  parent = "",
): Promise<ResourcePage> {
  if (kind === "business_location") {
    let locations;
    try {
      locations = await businessLocations(workspaceId);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load business locations.";
      throw new ResourceLookupError(message, /connect|reconnect|not set up/i.test(message) ? 409 : 502);
    }
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ResourceLookupError("Invalid business location cursor.");
    const page = locations.slice(offset, offset + 100);
    return {
      choices: page.map(({ name, title, account }) => ({ value: name, label: title || name, secondary: account })),
      nextCursor: offset + page.length < locations.length ? String(offset + page.length) : null,
    };
  }
  const toolkit = TOOLKIT[kind];
  const accounts = toolkit && composioConfigured ? await connectedAccountIds(workspaceId, toolkit, fetch, true) : [];
  if (!toolkit || !accounts.length) {
    throw new ResourceLookupError(`Connect ${toolkit ?? "the app"} to choose an option.`, 409);
  }
  if (accounts.length > 1) throw new ResourceLookupError(`Multiple ${toolkit} accounts are connected. Choose one account in Integrations before selecting a resource.`, 409);

  if (kind === "slack_channel") {
    const page = await slackChannelPage(workspaceId, cursor, true);
    return { choices: normalizeResourceChoices(kind, page), nextCursor: page.nextCursor };
  }
  if (kind === "linkedin_organization") {
    const pages = await linkedinCompanyPages(workspaceId, true);
    const named = await Promise.all(pages.map(async (page) => {
      if (page.name !== page.id) return page;
      try {
        const data = await providerResponse(
          workspaceId,
          toolkit,
          `https://api.linkedin.com/rest/organizations/${encodeURIComponent(page.id)}`,
          "GET",
          undefined,
          [
            { name: "LinkedIn-Version", value: env.linkedinApiVersion, type: "header" },
            { name: "X-Restli-Protocol-Version", value: "2.0.0", type: "header" },
          ],
        );
        const localized = data.localizedName;
        return { ...page, name: typeof localized === "string" && localized ? localized : page.id };
      } catch {
        return page;
      }
    }));
    return { choices: normalizeResourceChoices(kind, { pages: named }), nextCursor: null };
  }
  if (kind === "search_console_site") {
    const body = await providerResponse(workspaceId, toolkit, "https://www.googleapis.com/webmasters/v3/sites");
    return { choices: normalizeResourceChoices(kind, body), nextCursor: null };
  }
  if (kind === "google_calendar") {
    const url = new URL("https://www.googleapis.com/calendar/v3/users/me/calendarList");
    url.searchParams.set("maxResults", "100");
    if (cursor) url.searchParams.set("pageToken", cursor);
    const body = await providerResponse(workspaceId, toolkit, url.toString());
    return { choices: normalizeResourceChoices(kind, body), nextCursor: pageToken(body.nextPageToken) };
  }
  if (kind === "ga4_property") {
    const url = new URL("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    url.searchParams.set("pageSize", "200");
    if (cursor) url.searchParams.set("pageToken", cursor);
    const body = await providerResponse(workspaceId, toolkit, url.toString());
    return { choices: normalizeResourceChoices(kind, body), nextCursor: pageToken(body.nextPageToken) };
  }

  const group = kind === "linear_team" ? "teams" : "projects";
  const fields = group === "teams"
    ? "id name"
    : "id name teams { nodes { id } }";
  const query = `query ResourceChoices($after: String) { ${group}(first: 100, after: $after) { nodes { ${fields} } pageInfo { hasNextPage endCursor } } }`;
  const body = await providerResponse(
    workspaceId,
    toolkit,
    "https://api.linear.app/graphql",
    "POST",
    { query, variables: { after: cursor || null } },
    [{ name: "Content-Type", value: "application/json", type: "header" }],
  );
  const result = (body.data ?? {}) as Record<string, unknown>;
  const connection = (result[group] ?? {}) as Record<string, unknown>;
  let choices = normalizeResourceChoices(kind, body);
  if (parent && kind === "linear_project") {
    const nodes = Array.isArray(connection.nodes) ? connection.nodes as Array<Record<string, unknown>> : [];
    const allowed = new Set(nodes.filter((node) => {
      const teams = (node.teams ?? {}) as { nodes?: Array<{ id?: string }> };
      return teams.nodes?.some((team) => team.id === parent);
    }).map((node) => String(node.id)));
    choices = choices.filter((item) => allowed.has(item.value));
  }
  const pageInfo = (connection.pageInfo ?? {}) as Record<string, unknown>;
  return { choices, nextCursor: pageInfo.hasNextPage ? pageToken(pageInfo.endCursor) : null };
}
