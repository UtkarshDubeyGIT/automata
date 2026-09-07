import { twilioClient, verificationError } from "@/lib/whatsapp/twilio";
import { jsonBody } from "@/lib/request";
import { NextResponse } from "next/server";
import { env, twilioVerifyConfigured } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const db = await createClient();
  const { data: { user } } = await db.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  const body = await jsonBody<Record<string, unknown>>(req);
  if (body?.consent !== true) return NextResponse.json({ error: "Explicit WhatsApp consent is required." }, { status: 400 });
  if (!twilioVerifyConfigured) return NextResponse.json({ error: "SMS verification is not available yet." }, { status: 503 });
  if (typeof body.code !== "string" || !/^\d{4,10}$/.test(body.code)) return NextResponse.json({ error: "Enter the numeric code sent by SMS." }, { status: 400 });
  const { data: profile } = await db.from("whatsapp_profiles").select("phone_e164").eq("user_id", user.id).maybeSingle();
  if (!profile) return NextResponse.json({ error: "Start verification first." }, { status: 409 });

  let approved = false;
  try {
    const check = await twilioClient().verify.v2
      .services(env.twilioVerifyServiceSid).verificationChecks.create({ to: profile.phone_e164, code: body.code });
    approved = check.status === "approved";
  } catch (error) { return verificationError(error); }
  if (!approved) return NextResponse.json({ error: "The verification code was not approved." }, { status: 400 });
  const now = new Date().toISOString();
  const { data: saved, error } = await db.from("whatsapp_profiles").update({
    verified_at: now, consented_at: now,
    consent_source: "twilio_verify_sms",
    enabled: true, workflow_reminders: true, updated_at: now,
  }).eq("user_id", user.id).eq("phone_e164", profile.phone_e164).select("user_id").maybeSingle();
  if (error) return NextResponse.json({ error: "Could not save verification. Request a new code." }, { status: 500 });
  if (!saved) return NextResponse.json({ error: "Phone number changed. Request a new code." }, { status: 409 });
  return NextResponse.json({ verified: true });
}
