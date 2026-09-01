import assert from "node:assert/strict";
import test from "node:test";

import { redactForLog } from "../src/lib/security/redact";

test("execution logs redact credential-shaped keys at every depth", () => {
  assert.deepEqual(redactForLog({
    email: "ava@example.com",
    authorization: "Bearer secret",
    nested: { api_key: "sk_live_123", accessToken: "oauth", ok: true },
  }), {
    email: "ava@example.com",
    authorization: "[REDACTED]",
    nested: { api_key: "[REDACTED]", accessToken: "[REDACTED]", ok: true },
  });
});

test("execution logs truncate oversized strings and collections", () => {
  const redacted = redactForLog({ body: "x".repeat(20_000), rows: Array.from({ length: 150 }, (_, id) => ({ id })) }) as { body: string; rows: unknown[] };
  assert.ok(redacted.body.length < 11_000);
  assert.equal(redacted.rows.length, 101);
  assert.deepEqual(redacted.rows.at(-1), { truncated: 50 });
});
