import twilio from "twilio";
import { env } from "@/lib/env";

export function twilioClient() {
  const apiKeyReady = Boolean(env.twilioApiKey && env.twilioApiSecret);
  return twilio(apiKeyReady ? env.twilioApiKey : env.twilioAccountSid,
    apiKeyReady ? env.twilioApiSecret : env.twilioAuthToken,
    { accountSid: env.twilioAccountSid, timeout: 10_000, autoRetry: false });
}

export function verificationError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? Number(error.code) : 0;
  if ([60202, 60203, 20429].includes(code)) {
    return Response.json({ error: "Too many attempts. Wait before requesting a new code." }, { status: 429, headers: { "Retry-After": "60" } });
  }
  if (code === 20404) return Response.json({ error: "This code expired or was already used. Request a new code." }, { status: 400 });
  if ([60200, 21211].includes(code)) return Response.json({ error: "Check the phone number and verification code." }, { status: 400 });
  return Response.json({ error: "SMS verification is temporarily unavailable. Please try again later." }, { status: 503 });
}
