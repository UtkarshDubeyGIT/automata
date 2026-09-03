import { platformMeta } from "@/lib/social/platforms";
import { appLabel, getTool, getTrigger, SIMULATED_APPS } from "./registry";
import type { WorkflowGraph } from "./types";

/**
 * Which third-party accounts a graph needs, and whether this workspace has
 * them — the one answer shared by every place that asks.
 *
 * It lives here rather than in builder.ts because all three *creation* paths
 * have to ask it in the browser: the chat preview, the template gallery, and
 * the editor (which asks about the graph on the canvas, not the saved one, so
 * adding a Slack step names Slack immediately). builder.ts pulls in the
 * OpenAI client and `env`, so importing it from a client component breaks the
 * production build while `tsc --noEmit` stays green — hence the split, with
 * builder.ts re-exporting these for its existing server-side callers.
 *
 * Deriving the app list is pure; deciding the STATUS needs the workspace's
 * connection rows, which only ever come from `GET /api/integrations/connect`.
 * `statusOf` is the pure half of that so the mapping is written once and can
 * be tested without a network.
 */

export interface RequiredApp {
  /** Toolkit slug ("googlebusinessprofile", "gmail", …) or social platform id. */
  app: string;
  label: string;
  /** No Composio toolkit — nothing can ever connect it, actions run simulated. */
  simulated: boolean;
}

/**
 * `simulated` is deliberately NOT a kind of "connected".
 *
 * It used to be: `POST /api/integrations/connect` writes a cached `connected`
 * row for an app with no toolkit, so Google Business Profile answered
 * "Connected" with a green check while every single call against it was a
 * fabrication. Whoever pressed that button was told the exact opposite of
 * what was true. A demo app is now its own state everywhere, and the Connect
 * button is not offered for one.
 */
export type ConnectionStatus =
  /** Not asked yet, or the answer never arrived. Never blocks anything. */
  | "unknown"
  /** Authorized and usable. */
  | "connected"
  /** OAuth started, not finished. */
  | "pending"
  /** Connectable, and not connected. */
  | "none"
  /** No live connection is possible — runs produce realistic fakes. */
  | "simulated";

export interface AppConnection extends RequiredApp {
  status: ConnectionStatus;
}

/** One row of `GET /api/integrations/connect`. */
export interface IntegrationRow {
  platform: string;
  status: string;
}

/** Every app/channel the graph touches: trigger app, app_action apps, social platforms. */
export function requiredAppsOf(graph: WorkflowGraph): RequiredApp[] {
  const slugs = new Set<string>();
  for (const step of Object.values(graph.steps)) {
    if (step.type === "app_event_trigger") {
      const spec = getTrigger(String(step.event ?? ""));
      if (spec) slugs.add(spec.app);
    } else if (step.type === "app_action") {
      const spec = getTool(String(step.tool ?? ""));
      if (spec) slugs.add(spec.app);
    } else if (step.type === "social_post") {
      const platform = String(step.platform ?? "");
      if (platform) slugs.add(platform);
    }
  }
  return [...slugs].map(appOf);
}

/**
 * Does this graph produce anything that has to be ABOUT the business?
 *
 * True for the three steps that generate rather than move data: an `ai_step`
 * writes copy, a `generate_image` makes a picture and a `generate_video` films
 * a clip, and all three are grounded in the workspace's brand profile at run
 * time. Everything else — reading a repo,
 * routing on a value, posting text an earlier step already wrote — is
 * indifferent to whether we know what the company sells.
 *
 * Lives beside `requiredAppsOf` and for the same reason: all three creation
 * paths ask it in the browser, about the graph in front of the user rather
 * than the saved one, so dropping in an AI step raises the question at once.
 */
export function needsBrandGrounding(graph: WorkflowGraph): boolean {
  return Object.values(graph.steps).some(
    (s) => s.type === "ai_step" || s.type === "generate_image" || s.type === "generate_video",
  );
}

/** One slug as a `RequiredApp` — the social catalog's name wins where it has one. */
export function appOf(app: string): RequiredApp {
  return {
    app,
    label: platformMeta(app)?.name ?? appLabel(app),
    simulated: SIMULATED_APPS.has(app),
  };
}

/**
 * What this workspace's connection rows say about one app.
 *
 * `live` is the install-wide `COMPOSIO_API_KEY` flag the same endpoint
 * returns. With no key, `steps.ts` simulates EVERY app_action regardless of
 * toolkit, so reporting anything as connected there would be the same lie in
 * a different place — the whole install is a demo, and it says so.
 */
export function statusOf(
  app: RequiredApp,
  rows: IntegrationRow[] | null,
  live: boolean,
): ConnectionStatus {
  if (app.simulated || !live) return "simulated";
  if (!rows) return "unknown";
  const row = rows.find((r) => r.platform === app.app);
  if (row?.status === "connected") return "connected";
  if (row?.status === "pending") return "pending";
  return "none";
}

export function connectionsOf(
  apps: RequiredApp[],
  rows: IntegrationRow[] | null,
  live: boolean,
): AppConnection[] {
  return apps.map((app) => ({ ...app, status: statusOf(app, rows, live) }));
}

/**
 * The accounts standing between the user and an automation that can run.
 *
 * `unknown` is not one of them on purpose: our own status endpoint being
 * unreachable is our problem, and refusing to create an automation over it
 * would strand the user with nothing they can do. A demo app is not one
 * either — no amount of connecting changes it.
 */
export function unconnected(connections: AppConnection[]): AppConnection[] {
  return connections.filter((c) => c.status === "none" || c.status === "pending");
}
