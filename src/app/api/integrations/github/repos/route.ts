import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { githubRepositories, type GithubRepo } from "@/lib/social/composio";

/**
 * Repos on the workspace's connected GitHub account — powers the workflow
 * editor's repo picker so owner/repo are chosen from a list instead of typed
 * by hand. Cached briefly per workspace: this backs a dropdown that can be
 * opened more than once while a step is being edited.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; repos: GithubRepo[] }>();

export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.entityId) return NextResponse.json({ repos: [] });

  const hit = cache.get(ctx.entityId);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json({ repos: hit.repos });
    cache.delete(ctx.entityId);
  }

  const repos = await githubRepositories(ctx.entityId);
  cache.set(ctx.entityId, { at: Date.now(), repos });
  return NextResponse.json({ repos });
}
