import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { githubRepositories, type GithubRepo } from "@/lib/social/composio";
import { connectedAccountIds } from "@/lib/social/composio-proxy";
import { composioConfigured } from "@/lib/env";

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
  if (!ctx.userId || !ctx.workspaceId || ctx.entityId !== ctx.workspaceId) return NextResponse.json({ error: "Sign in to choose a repository." }, { status: 401 });
  const accounts = composioConfigured ? await connectedAccountIds(ctx.workspaceId, "github", fetch, true).catch(() => null) : [];
  if (!accounts) return NextResponse.json({ error: "Could not check GitHub connection. Try again." }, { status: 502 });
  if (!accounts.length) return NextResponse.json({ error: "Connect GitHub to choose a repository." }, { status: 409 });
  if (accounts.length > 1) return NextResponse.json({ error: "Multiple GitHub accounts are connected. Choose one in Integrations." }, { status: 409 });

  const hit = cache.get(ctx.entityId);
  if (hit) {
    if (Date.now() - hit.at < TTL_MS) return NextResponse.json({ repos: hit.repos });
    cache.delete(ctx.entityId);
  }

  try {
    const repos = await githubRepositories(ctx.entityId, true);
    cache.set(ctx.entityId, { at: Date.now(), repos });
    return NextResponse.json({ repos });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load repositories." }, { status: 502 });
  }
}
