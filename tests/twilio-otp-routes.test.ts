import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
const db = new FakeDb();
let user: { id: string } | null = { id: "u1" };
let failure: unknown;
let status = "pending";
let credentials: unknown[] = [];
let calls = 0;
let duringCheck = () => {};
const env = { twilioAccountSid: "ACtest", twilioApiKey: "SKpartial", twilioApiSecret: "", twilioAuthToken: "token", twilioVerifyServiceSid: "VAtest", twilioWhatsAppSandbox: true };
mock.module("@/lib/env", { namedExports: { env, twilioVerifyConfigured: true } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => Object.assign(db, { auth: { getUser: async () => ({ data: { user } }) } }) } });
mock.module("twilio", { defaultExport: (...args: unknown[]) => {
  credentials = args;
  return { verify: { v2: { services: () => ({
    verifications: { create: async () => { calls++; if (failure) throw failure; return { status: "pending" }; } },
    verificationChecks: { create: async () => { calls++; if (failure) throw failure; duringCheck(); return { status }; } },
  }) } } };
} });
const { POST: start } = await import("@/app/api/whatsapp/verify/start/route");
const { POST: check } = await import("@/app/api/whatsapp/verify/check/route");
function reset() { user = { id: "u1" }; failure = undefined; status = "pending"; calls = 0; duringCheck = () => {}; db.replace("workspaces", [{ id: "w1", owner_id: "u1" }]); db.replace("whatsapp_profiles", [{ user_id: "u1", phone_e164: "+14155552671", verified_at: null }]); }
function request(body: unknown) { return new Request("https://example.com", { method: "POST", body: JSON.stringify(body) }); }
test("invalid phone types return 400 without sending", async () => { reset(); assert.equal((await start(request({ phone: 123 }))).status, 400); assert.equal(calls, 0); });
test("unauthenticated requests cannot send", async () => { reset(); user = null; assert.equal((await start(request({ phone: "+14155552671" }))).status, 401); assert.equal(calls, 0); });
test("partial API credentials fall back to the complete account credential pair", async () => { reset(); assert.equal((await start(request({ phone: "+14155552671" }))).status, 200); assert.deepEqual(credentials.slice(0, 2), ["ACtest", "token"]); });
test("failed sends preserve the existing phone profile", async () => { reset(); failure = { code: 60203 }; assert.equal((await start(request({ phone: "+14155552672" }))).status, 429); assert.equal(db.table("whatsapp_profiles")[0].phone_e164, "+14155552671"); });
test("consent must be literal true", async () => { reset(); status = "approved"; assert.equal((await check(request({ code: "123456", consent: "false" }))).status, 400); assert.equal(calls, 0); });
test("non-digit codes are rejected before contacting Twilio", async () => { reset(); assert.equal((await check(request({ code: "sandbox-joined", consent: true }))).status, 400); assert.equal(calls, 0); });
test("wrong codes never enable the profile", async () => { reset(); assert.equal((await check(request({ code: "123456", consent: true }))).status, 400); assert.equal(db.table("whatsapp_profiles")[0].verified_at, null); });
test("expired codes return an actionable response", async () => { reset(); failure = { code: 20404 }; assert.equal((await check(request({ code: "123456", consent: true }))).status, 400); });
test("approval cannot verify a phone changed during the provider request", async () => { reset(); status = "approved"; duringCheck = () => { db.table("whatsapp_profiles")[0].phone_e164 = "+14155552672"; }; assert.equal((await check(request({ code: "123456", consent: true }))).status, 409); assert.equal(db.table("whatsapp_profiles")[0].verified_at, null); });
test("approved code persists verification and consent", async () => { reset(); status = "approved"; assert.equal((await check(request({ code: "123456", consent: true }))).status, 200); assert.ok(db.table("whatsapp_profiles")[0].verified_at); });
