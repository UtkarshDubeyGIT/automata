import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

interface WorkspaceNotice {
  workspaceId: string;
  kind: "approval" | "failure" | "connection" | "credits";
  title: string;
  body: string;
  href: string;
  /**
   * Whether this kind is allowed to leave the app.
   *
   * Failures get an email because they are the case where nobody is looking at
   * the tab. Approvals do not: they already have a WhatsApp reminder, and
   * mailing every member on every gate turns a normal workflow into a mailing
   * list. Per-user preferences still apply on top of this.
   */
  email?: boolean;
  /**
   * Idempotency key, unique per user. A repeat delivery is skipped entirely —
   * both the row and the email — which is what keeps a run that fails, gets
   * reclaimed, and fails again from notifying twice.
   */
  dedupeKey?: string;
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

/**
 * Look up a member's email address.
 *
 * Guarded because the callers hand us whatever admin client they were given,
 * and the run-driving tests substitute a minimal fake that has no `.auth` at
 * all. A notification is never worth taking down a workflow run, so an
 * unavailable admin API just means no email for that member.
 */
async function emailFor(admin: SupabaseClient, userId: string): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    return data.user?.email ?? null;
  } catch {
    return null;
  }
}

export async function notifyWorkspace(admin: SupabaseClient, notice: WorkspaceNotice) {
  const { data: members } = await admin.from("workspace_members").select("user_id").eq("workspace_id", notice.workspaceId);
  for (const member of members ?? []) {
    const { data: preference } = await admin.from("notification_preferences").select("in_app,email,events").eq("workspace_id", notice.workspaceId).eq("user_id", member.user_id).maybeSingle();
    const enabled = (preference?.events as Record<string, boolean> | null)?.[notice.kind] ?? true;
    if (!enabled) continue;

    /**
     * One key gates both channels. Checked before the send, not just relied on
     * as an insert conflict, because the email goes out first and a swallowed
     * duplicate row would still have mailed the user a second time.
     */
    if (notice.dedupeKey) {
      const { data: seen } = await admin
        .from("notifications")
        .select("id")
        .eq("user_id", member.user_id)
        .eq("dedupe_key", notice.dedupeKey)
        .maybeSingle();
      if (seen) continue;
    }

    let emailStatus = "skipped";
    if (notice.email !== false && preference?.email !== false) {
      const address = await emailFor(admin, member.user_id);
      if (address) emailStatus = await sendEmail(address, notice);
    }
    if (preference?.in_app !== false) {
      await admin.from("notifications").insert({
        workspace_id: notice.workspaceId,
        user_id: member.user_id,
        kind: notice.kind,
        title: notice.title,
        body: notice.body,
        href: notice.href,
        email_status: emailStatus,
        ...(notice.dedupeKey ? { dedupe_key: notice.dedupeKey } : {}),
      });
    }
  }
}
