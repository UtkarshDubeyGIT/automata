import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const env = readFileSync("src/lib/env.ts", "utf8");
const start = readFileSync("src/app/api/whatsapp/verify/start/route.ts", "utf8");
const check = readFileSync("src/app/api/whatsapp/verify/check/route.ts", "utf8");
const settings = readFileSync("src/components/whatsapp-settings.tsx", "utf8");

test("SMS phone verification does not require a WhatsApp sender", () => {
  assert.match(env, /twilioVerifyConfigured = !!\(\s*env\.twilioAccountSid/);
  assert.doesNotMatch(env, /twilioConfigured && env\.twilioVerifyServiceSid/);
  assert.match(start, /channel: "sms"/);
  assert.doesNotMatch(start, /channel: "whatsapp"/);
});

test("WhatsApp settings clearly separates SMS OTP verification from Sandbox joining", () => {
  assert.match(settings, /Send SMS code/);
  assert.match(settings, /6-digit verification code by SMS/);
  assert.match(settings, /mode === "sms" && !code\.trim\(\)/);
  assert.match(settings, /Join the Twilio WhatsApp Sandbox/);
  assert.match(check, /consent_source: .*twilio_verify_sms/);
});
