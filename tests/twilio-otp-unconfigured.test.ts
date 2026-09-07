import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
const db = new FakeDb();
db.seed("whatsapp_profiles", { user_id: "u1", phone_e164: "+14155552671", verified_at: null });
mock.module("@/lib/env", { namedExports: { env: { twilioWhatsAppSandbox: true }, twilioVerifyConfigured: false } });
mock.module("@/lib/supabase/server", { namedExports: { createClient: async () => Object.assign(db, { auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) } });
const { POST } = await import("@/app/api/whatsapp/verify/check/route");
test("Sandbox self-attestation cannot verify phone ownership without Verify", async () => {
  const response = await POST(new Request("https://example.com", { method: "POST", body: JSON.stringify({ code: "sandbox-joined", consent: true }) }));
  assert.equal(response.status, 503);
  assert.equal(db.table("whatsapp_profiles")[0].verified_at, null);
});
