import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { slackUsers, type SlackUser } from "@/lib/social/composio";
import { connectedAccountIds } from "@/lib/social/composio-proxy";
import { composioConfigured } from "@/lib/env";

/**
 * Users/members on the workspace's connected Slack account — powers the workflow
 * editor's DM recipient picker so team members are selected from a clean dropdown.
 * Cached briefly per workspace.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; users: SlackUser[] }>();

export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.userId || !ctx.workspaceId || ctx.entityId !== ctx.workspaceId) return NextResponse.json({ error: "Sign in to choose a Slack member." }, { status: 401 });
  const accounts = composioConfigured ? await connectedAccountIds(ctx.workspaceId, "slack", fetch, true).catch(() => null) : [];
  if (!accounts) return NextResponse.json({ error: "Could not check Slack connection. Try again." }, { status: 502 });
  if (!accounts.length) return NextResponse.json({ error: "Connect Slack to choose a team member." }, { status: 409 });
  if (accounts.length > 1) return NextResponse.json({ error: "Multiple Slack accounts are connected. Choose one in Integrations." }, { status: 409 });
  const key = ctx.workspaceId;

  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json({ users: hit.users });
    cache.delete(key);
  }

  try {
    const users = await slackUsers(ctx.workspaceId, true);
    cache.set(key, { at: Date.now(), users });
    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load Slack users." }, { status: 502 });
  }
}
