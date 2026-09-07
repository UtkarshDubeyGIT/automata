import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { safeTimeZone } from "@/lib/workflows/blocks";
import { twilioVerifyConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

async function session() {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return null;
  const { data: workspace } = await db.from("workspaces").select("id").eq("owner_id", user.id).maybeSingle();
  return workspace ? { db, user, workspace } : null;
}

export async function GET() {
  const auth = await session();
  if (!auth) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data: profile } = await auth.db
    .from("whatsapp_profiles")
    .select("phone_e164, verified_at, consented_at, consent_source, locale, timezone, enabled, workflow_reminders, general_reminders")
    .eq("user_id", auth.user.id)
    .maybeSingle();
  return NextResponse.json({
    profile: profile ?? null,
    setupMode: twilioVerifyConfigured ? "sms" : "unavailable",
  });
}

export async function PATCH(req: Request) {
  const auth = await session();
  if (!auth) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await req.json().catch(() => null) as {
    enabled?: boolean; workflowReminders?: boolean; generalReminders?: boolean; locale?: string; timezone?: string;
  } | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const { data: current } = await auth.db.from("whatsapp_profiles").select("verified_at, consented_at").eq("user_id", auth.user.id).maybeSingle();
  if (!current) return NextResponse.json({ error: "Verify a phone number first." }, { status: 409 });
  const wantsEnabled = body.enabled ?? undefined;
  if ((wantsEnabled || body.workflowReminders || body.generalReminders) && (!current.verified_at || !current.consented_at)) {
    return NextResponse.json({ error: "Verification and consent are required." }, { status: 409 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (typeof body.workflowReminders === "boolean") patch.workflow_reminders = body.workflowReminders;
  if (typeof body.generalReminders === "boolean") patch.general_reminders = body.generalReminders;
  if (typeof body.locale === "string") patch.locale = body.locale.trim().slice(0, 12) || "en";
  if (typeof body.timezone === "string") patch.timezone = safeTimeZone(body.timezone);
  const { error } = await auth.db.from("whatsapp_profiles").update(patch).eq("user_id", auth.user.id);
  if (error) return NextResponse.json({ error: "Could not update WhatsApp settings." }, { status: 500 });
  return NextResponse.json({ ok: true });
}
