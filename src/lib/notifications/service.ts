import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

interface WorkspaceNotice {
  workspaceId: string;
  kind: "approval" | "failure" | "connection" | "credits";
  title: string;
  body: string;
  href: string;
}

async function sendEmail(to: string, notice: WorkspaceNotice): Promise<"sent" | "skipped" | "failed"> {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return "skipped";
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject: notice.title, text: `${notice.body}\n\nOpen Automata: ${(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000")}${notice.href}` }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok ? "sent" : "failed";
  } catch { return "failed"; }
}

export async function notifyWorkspace(admin: SupabaseClient, notice: WorkspaceNotice) {
  const { data: members } = await admin.from("workspace_members").select("user_id").eq("workspace_id", notice.workspaceId);
  for (const member of members ?? []) {
    const { data: preference } = await admin.from("notification_preferences").select("in_app,email,events").eq("workspace_id", notice.workspaceId).eq("user_id", member.user_id).maybeSingle();
    const enabled = (preference?.events as Record<string, boolean> | null)?.[notice.kind] ?? true;
    if (!enabled) continue;
    let emailStatus = "skipped";
    if (preference?.email !== false) {
      const { data } = await admin.auth.admin.getUserById(member.user_id);
      if (data.user?.email) emailStatus = await sendEmail(data.user.email, notice);
    }
    if (preference?.in_app !== false) await admin.from("notifications").insert({ workspace_id: notice.workspaceId, user_id: member.user_id, kind: notice.kind, title: notice.title, body: notice.body, href: notice.href, email_status: emailStatus });
  }
}
