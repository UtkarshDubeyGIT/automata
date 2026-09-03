import { NextResponse } from "next/server";
import { slackChannels, type SlackChannel } from "@/lib/social/composio";
import { resolveRequestContext } from "@/lib/workspace";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; channels: SlackChannel[] }>();

export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.entityId) {
    return NextResponse.json({ error: "Sign in to list Slack channels." }, { status: 401 });
  }

  const hit = cache.get(ctx.entityId);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json({ channels: hit.channels });
    cache.delete(ctx.entityId);
  }

  const channels = await slackChannels(ctx.entityId);
  cache.set(ctx.entityId, { at: Date.now(), channels });
  return NextResponse.json({ channels });
}
