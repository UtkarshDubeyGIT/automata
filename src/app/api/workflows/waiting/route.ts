import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";

/**
 * How many runs are blocked on this user's decision.
 *
 * Its own endpoint rather than a field on the workflow list, because the
 * sidebar polls it from every screen and the list response is far too heavy
 * for that — it carries every workflow's config, display model and run
 * history. This is one indexed count.
 *
 * A `waiting` run is the only state in the product that NOTHING will ever
 * resolve on its own: no beat, no retry, no timeout short of the 30-day
 * expiry. Making it visible only to someone already on the Automations tab,
 * who then clicks the right filter, is not making it visible.
 *
 * (Static segment, so it takes precedence over /api/workflows/[id]. Workflow
 * ids are UUIDs, so nothing can ever be shadowed by it.)
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ waiting: 0 });
  }

  // RLS scopes workflow_runs through the parent workflow, so this is already
  // this workspace's runs and nobody else's.
  const { count, error } = await rc.supabase
    .from("workflow_runs")
    .select("id", { count: "exact", head: true })
    .eq("status", "waiting");

  if (error) {
    // A badge is not worth a 500 on every screen. Report none and move on.
    return NextResponse.json({ waiting: 0 });
  }
  return NextResponse.json({ waiting: count ?? 0 });
}
