import { NextResponse } from "next/server";
import { firecrawlConfigured } from "@/lib/env";
import { resolveRequestContext } from "@/lib/workspace";

/**
 * Read-only status for web research.
 *
 * Firecrawl runs on ONE server-owned key (`FIRECRAWL_API_KEY`) shared by every
 * workspace, so there is nothing here to connect, replace or disconnect — this
 * endpoint exists only so client surfaces can say whether web research steps
 * will run. It stays behind a session so an anonymous caller can't fingerprint
 * which providers this install has configured.
 */
export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to view integrations." }, { status: 401 });
  }
  return NextResponse.json({ configured: firecrawlConfigured });
}
