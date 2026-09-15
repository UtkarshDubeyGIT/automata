import { createClient } from "@/lib/supabase/server";
import { getBalance } from "@/lib/credits";
import { supabaseConfigured } from "@/lib/env";

export type ServerSupabase = Awaited<ReturnType<typeof createClient>>;

export interface RequestContext {
  supabase: ServerSupabase | null;
  userId: string | null;
  workspaceId: string | null;
  entityId: string | null;
}

const PREVIEW_CONTEXT: RequestContext = {
  supabase: null,
  userId: null,
  workspaceId: null,
  entityId: "demo-user",
};

const ANONYMOUS_CONTEXT: RequestContext = {
  supabase: null,
  userId: null,
  workspaceId: null,
  entityId: null,
};

async function workspaceForUser(supabase: ServerSupabase, userId: string): Promise<string | null> {
  // The `order` is load-bearing, not cosmetic. The signup trigger gives every
  // user their own workspace, so anyone who also accepts an invitation holds
  // two memberships, and an unordered `limit(1)` chose between them
  // arbitrarily — the same person could resolve to a different workspace on
  // consecutive requests. Oldest-first pins them to the one created at signup.
  const { data: member } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("user_id", userId)
    .order("joined_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (member?.workspace_id) return member.workspace_id;

  // Support both Automata workspaces and existing Zidane workspaces. Every
  // lookup remains scoped to the authenticated user through the RLS client.
  for (const ownerColumn of ["created_by", "owner_id"]) {
    const { data: workspace } = await supabase
      .from("workspaces")
      .select("id")
      .eq(ownerColumn, userId)
      .limit(1)
      .maybeSingle();
    if (workspace?.id) return workspace.id;
  }
  return null;
}

interface WorkspaceRow {
  id: string;
  name: string | null;
  plan: string | null;
  created_at: string | null;
  onboarded: boolean | null;
}

type DatabaseError = { code?: string; message?: string } | null;

function missingOnboarded(error: DatabaseError) {
  return !!error && ["42703", "PGRST204"].includes(error.code ?? "") && /onboarded/i.test(error.message ?? "");
}

/**
 * Zidane-baseline databases can lag the migration that adds `onboarded`.
 * Selecting a column Postgres does not have fails the entire row, which would
 * blank the workspace name, plan, and credit balance as a side effect — so
 * retry without it and treat the flag as `true`, matching the fail-open
 * posture of the DEMO context.
 */
async function readWorkspaceRow(supabase: ServerSupabase, workspaceId: string): Promise<WorkspaceRow | null> {
  const full = await supabase
    .from("workspaces")
    .select("id, name, plan, created_at, onboarded")
    .eq("id", workspaceId)
    .limit(1)
    .maybeSingle();
  if (!missingOnboarded(full.error)) return (full.data as WorkspaceRow | null) ?? null;

  const legacy = await supabase
    .from("workspaces")
    .select("id, name, plan, created_at")
    .eq("id", workspaceId)
    .limit(1)
    .maybeSingle();
  return legacy.data ? ({ ...(legacy.data as Omit<WorkspaceRow, "onboarded">), onboarded: true }) : null;
}

export async function resolveRequestContext(): Promise<RequestContext> {
  if (!supabaseConfigured) return PREVIEW_CONTEXT;
  try {
    const supabase = await createClient();
    if (!supabase) return PREVIEW_CONTEXT;
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const workspaceId = await workspaceForUser(supabase, user.id);

      return {
        supabase,
        userId: user.id,
        workspaceId,
        entityId: workspaceId ?? user.id,
      };
    }

    return { ...ANONYMOUS_CONTEXT, supabase };
  } catch {
    return ANONYMOUS_CONTEXT;
  }
}

export interface WorkspaceContext {
  userName: string;
  userEmail: string;
  userAvatarUrl: string | null;
  workspaceId: string | null;
  workspaceName: string;
  /** ISO timestamp of workspace creation; null in demo mode. Drives the first-time-user welcome. */
  workspaceCreatedAt: string | null;
  plan: string;
  credits: number;
  onboarded: boolean;
  demo: boolean;
}

const DEMO: WorkspaceContext = {
  userName: "Alex Rivers",
  userEmail: "alex@automata.local",
  userAvatarUrl: null,
  workspaceId: null,
  workspaceName: "Automata Workspace",
  workspaceCreatedAt: null,
  plan: "pro",
  credits: 2500,
  onboarded: true,
  demo: true,
};

export async function getWorkspaceContext(): Promise<WorkspaceContext> {
  if (!supabaseConfigured) return DEMO;
  try {
    const supabase = await createClient();
    if (!supabase) return DEMO;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return DEMO;

    const workspaceId = await workspaceForUser(supabase, user.id);

    const ws = await readWorkspaceRow(supabase, workspaceId ?? "");

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, avatar_url")
      .eq("id", user.id)
      .maybeSingle();

    const credits = ws?.id ? await getBalance(ws.id) : 0;

    return {
      userName: profile?.full_name || user.email?.split("@")[0] || "there",
      userEmail: user.email ?? "",
      userAvatarUrl: profile?.avatar_url ?? null,
      workspaceId: ws?.id ?? null,
      workspaceName: ws?.name ?? "My workspace",
      workspaceCreatedAt: ws?.created_at ?? null,
      plan: ws?.plan ?? "free",
      credits,
      // Absent row or a database that predates the column both fail open: a
      // lookup problem must not trap a signed-in user in the first-run flow.
      onboarded: ws?.onboarded ?? true,
      demo: false,
    };
  } catch {
    return DEMO;
  }
}
