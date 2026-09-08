import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const page = readFileSync("src/app/app/workflows/page.tsx", "utf8");
const chat = readFileSync("src/app/app/workflows/builder-chat.tsx", "utf8");
const connections = readFileSync("src/components/connect-apps.tsx", "utf8");

test("template creation takes a synchronous lock before connection preflight", () => {
  assert.match(page, /const creatingRef = useRef\(false\)/);
  const lock = page.indexOf("creatingRef.current = true");
  const preflight = page.indexOf("await resolve(");
  assert.ok(lock >= 0 && preflight >= 0 && lock < preflight);
  assert.match(page, /requestWorkflowCreation\(/);
});

test("chat saves use the shared creation request and ignore stale completions", () => {
  assert.match(chat, /requestWorkflowCreation\(/);
  assert.match(chat, /const seq = seqRef\.current/);
  assert.match(chat, /if \(seq !== seqRef\.current\) return/);
  assert.match(chat, /let keepLocked = false/);
  assert.match(chat, /if \(!keepLocked\) \{/);
  assert.match(chat, /disabled=\{saving \|\| navigationPending\}/);
});

test("a successful create exposes navigation progress and a normal fallback link", () => {
  assert.match(page, /useTransition\(\)/);
  assert.match(page, /role="status"/);
  assert.match(page, /Opening automation/);
  assert.match(page, /<Link href=\{createdHref\}/);
});

test("connection status loading is single-flight", () => {
  assert.match(connections, /const inFlight = useRef<Promise/);
  assert.match(connections, /if \(inFlight\.current\) return inFlight\.current/);
});
