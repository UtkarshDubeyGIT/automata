import { NextResponse } from "next/server";

import { resolveRequestContext } from "@/lib/workspace";

/**
 * Read and write `notification_preferences`.
 *
 * Deliberately not folded into /api/settings: that route is a fixed whitelist
 * of string fields written into `workspaces.brand_profile`, and these are
 * booleans and a jsonb map on a different table keyed (workspace_id, user_id).
 *
 * It exists at all because notifyWorkspace() has always READ this table while
 * nothing ever wrote it — so the per-kind opt-outs it honours were unreachable,
 * and turning on failure emails without them would mean an email channel with
 * no off switch.
 */
export const dynamic = "force-dynamic";

/** Only the kinds that actually have a producer today. */
const KINDS = ["approval", "failure"] as const;

const DEFAULTS = { inApp: true, email: true, events: { approval: true, failure: true } };

export async function GET() {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId || !rc.userId) return NextResponse.json(DEFAULTS);

  const { data, error } = await rc.supabase
    .from("notification_preferences")
    .select("in_app, email, events")
    .eq("workspace_id", rc.workspaceId)
    .eq("user_id", rc.userId)
    .maybeSingle();

  if (error || !data) return NextResponse.json(DEFAULTS);

  const row = data as { in_app: boolean; email: boolean; events: Record<string, boolean> | null };
  const events = row.events ?? {};
  return NextResponse.json({
    inApp: row.in_app !== false,
    email: row.email !== false,
    // Absent key means "on" — the same permissive default the service uses.
    events: Object.fromEntries(KINDS.map((k) => [k, events[k] !== false])),
  });
}

export async function PATCH(request: Request) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId || !rc.userId) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as
    | { inApp?: boolean; email?: boolean; events?: Record<string, unknown> }
    | null;
  if (!body) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  // Merge onto what is stored rather than overwriting: the row also carries
  // `connection` and `credits` keys that this form does not render yet, and a
  // blind write would silently reset them.
  const { data: current } = await rc.supabase
    .from("notification_preferences")
    .select("in_app, email, events")
    .eq("workspace_id", rc.workspaceId)
    .eq("user_id", rc.userId)
    .maybeSingle();

  const existing = (current ?? {}) as {
    in_app?: boolean;
    email?: boolean;
    events?: Record<string, boolean> | null;
  };

  const events: Record<string, boolean> = { ...(existing.events ?? {}) };
  for (const kind of KINDS) {
    const value = body.events?.[kind];
    if (typeof value === "boolean") events[kind] = value;
  }

  const { error } = await rc.supabase.from("notification_preferences").upsert(
    {
      workspace_id: rc.workspaceId,
      user_id: rc.userId,
      in_app: typeof body.inApp === "boolean" ? body.inApp : existing.in_app ?? true,
      email: typeof body.email === "boolean" ? body.email : existing.email ?? true,
      events,
    },
    { onConflict: "workspace_id,user_id" },
  );

  if (error) return NextResponse.json({ error: "Could not save." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
