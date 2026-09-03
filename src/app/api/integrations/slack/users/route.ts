import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { slackUsers, type SlackUser } from "@/lib/social/composio";

/**
 * Users/members on the workspace's connected Slack account — powers the workflow
 * editor's DM recipient picker so team members are selected from a clean dropdown.
 * Cached briefly per workspace.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; users: SlackUser[] }>();

export async function GET() {
  const ctx = await resolveRequestContext();
  const key = ctx.entityId ?? "default";

  const hit = cache.get(key);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json({ users: hit.users });
    cache.delete(key);
  }

  const users = await slackUsers(ctx.entityId ?? "demo-user");
  cache.set(key, { at: Date.now(), users });
  return NextResponse.json({ users });
}
