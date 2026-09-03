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

export async function resolveRequestContext(): Promise<RequestContext> {
  if (!supabaseConfigured) return PREVIEW_CONTEXT;
  try {
    const supabase = await createClient();
    if (!supabase) return PREVIEW_CONTEXT;
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (user) {
      const { data: member } = await supabase
        .from("workspace_members")
        .select("workspace_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      const { data: ws } = member?.workspace_id
        ? { data: { id: member.workspace_id } }
        : await supabase
            .from("workspaces")
            .select("id")
            .eq("created_by", user.id)
            .limit(1)
            .maybeSingle();

      return {
        supabase,
        userId: user.id,
        workspaceId: ws?.id ?? null,
        entityId: ws?.id ?? user.id,
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
  workspaceId: string | null;
  workspaceName: string;
  plan: string;
  credits: number;
  onboarded: boolean;
  demo: boolean;
}

const DEMO: WorkspaceContext = {
  userName: "Alex Rivers",
  userEmail: "alex@automata.local",
  workspaceId: null,
  workspaceName: "Automata Workspace",
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

    const { data: member } = await supabase
      .from("workspace_members")
      .select("workspace_id")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();

    const { data: ws } = await supabase
      .from("workspaces")
      .select("id, name, plan")
      .eq("id", member?.workspace_id ?? "")
      .limit(1)
      .maybeSingle();

    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", user.id)
      .maybeSingle();

    const credits = ws?.id ? await getBalance(ws.id) : 0;

    return {
      userName: profile?.full_name || user.email?.split("@")[0] || "there",
      userEmail: user.email ?? "",
      workspaceId: ws?.id ?? null,
      workspaceName: ws?.name ?? "My workspace",
      plan: ws?.plan ?? "free",
      credits,
      onboarded: true,
      demo: false,
    };
  } catch {
    return DEMO;
  }
}
