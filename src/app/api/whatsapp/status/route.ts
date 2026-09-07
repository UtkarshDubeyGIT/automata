import twilio from "twilio";
import { env } from "@/lib/env";
import { applyTwilioStatus } from "@/lib/whatsapp/service";
import type { DeliveryStatus } from "@/lib/whatsapp/core";

const CALLBACK_STATUSES = new Set<DeliveryStatus>([
  "queued", "sent", "delivered", "read", "undelivered", "failed",
]);

export async function POST(req: Request) {
  if (!env.twilioAuthToken) return Response.json({ error: "Webhook is not configured." }, { status: 503 });
  const form = await req.formData();
  const params = Object.fromEntries([...form.entries()].map(([key, value]) => [key, String(value)]));
  const signature = req.headers.get("x-twilio-signature") ?? "";
  const callbackUrl = `${env.appUrl.replace(/\/$/, "")}/api/whatsapp/status`;
  if (!twilio.validateRequest(env.twilioAuthToken, signature, callbackUrl, params)) {
    return Response.json({ error: "Invalid Twilio signature." }, { status: 403 });
  }
  const status = String(params.MessageStatus ?? "") as DeliveryStatus;
  if (!params.MessageSid || !CALLBACK_STATUSES.has(status)) return new Response(null, { status: 204 });
  await applyTwilioStatus({
    messageSid: params.MessageSid,
    status,
    errorCode: params.ErrorCode || null,
    errorMessage: params.ErrorMessage || null,
  });
  return new Response(null, { status: 204 });
}
