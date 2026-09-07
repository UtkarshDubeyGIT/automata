import { twilioClient, verificationError } from "@/lib/whatsapp/twilio";
import { jsonBody } from "@/lib/request";
import { NextResponse } from "next/server";
import { env, twilioVerifyConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const { data: workspace } = await db.from("workspaces").select("id").eq("owner_id", user.id).maybeSingle();
  if (!workspace) return NextResponse.json({ error: "No workspace found." }, { status: 404 });
  const body = await jsonBody<Record<string, unknown>>(req);
  const phone = typeof body?.phone === "string" ? body.phone.replace(/[\s()-]/g, "") : "";
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    return NextResponse.json({ error: "Enter a phone number in E.164 format, such as +919876543210." }, { status: 400 });
  }
  if (!twilioVerifyConfigured) {
    return NextResponse.json({ error: "SMS verification is not configured yet." }, { status: 503 });
  }
  try {
    await twilioClient().verify.v2
    .services(env.twilioVerifyServiceSid).verifications.create({ to: phone, channel: "sms" });
  } catch (error) { return verificationError(error); }
  const { error } = await db.from("whatsapp_profiles").upsert({
    user_id: user.id, workspace_id: workspace.id, phone_e164: phone,
    verified_at: null, consented_at: null, enabled: false,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: "Could not save verification. Request a new code." }, { status: 500 });
  return NextResponse.json({ sent: true, channel: "sms" });
}
