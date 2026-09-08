import { NextResponse } from "next/server";

import { resolveRequestContext } from "@/lib/workspace";

/**
 * The in-app notification feed.
 *
 * Its own endpoint rather than a field on anything else, because the bell polls
 * it from every screen in the product. RLS (`notifications_read_self` /
 * `notifications_update_self`) already scopes both the read and the write to
 * the signed-in user, so this runs on the user-scoped client — no service role
 * anywhere on this path.
 *
 * Like /api/workflows/waiting, it degrades to an empty payload instead of
 * erroring: a bell that cannot load must not take the page down with it.
 */
export const dynamic = "force-dynamic";

/** Enough to fill the panel; the rest is history nobody scrolls a dropdown for. */
const LIMIT = 20;

const EMPTY = { items: [], unread: 0 };

export async function GET() {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) return NextResponse.json(EMPTY);

  const { data, error } = await rc.supabase
    .from("notifications")
    .select("id, kind, title, body, href, read_at, created_at")
    .eq("workspace_id", rc.workspaceId)
    .order("created_at", { ascending: false })
    .limit(LIMIT);

  if (error) return NextResponse.json(EMPTY);

  const rows = (data ?? []) as {
    id: string;
    kind: string;
    title: string;
    body: string;
    href: string | null;
    read_at: string | null;
    created_at: string;
  }[];

  // Counted separately from `rows` so the badge stays honest past the limit.
  const { count } = await rc.supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", rc.workspaceId)
    .is("read_at", null);

  return NextResponse.json({
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      href: row.href,
      readAt: row.read_at,
      createdAt: row.created_at,
    })),
    unread: count ?? 0,
  });
}

/** Mark one notification read (`{ id }`) or clear the badge (`{ all: true }`). */
export async function POST(request: Request) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) return NextResponse.json({ ok: false }, { status: 401 });

  const body = (await request.json().catch(() => null)) as
    | { id?: string; all?: boolean }
    | null;
  if (!body) return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });

  let query = rc.supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("workspace_id", rc.workspaceId)
    .is("read_at", null);

  if (body.all !== true) {
    if (!body.id) return NextResponse.json({ error: "Expected an id." }, { status: 400 });
    query = query.eq("id", body.id);
  }

  const { error } = await query;
  if (error) return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true });
}
