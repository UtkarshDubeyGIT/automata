import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  APP_WELCOME_KEY,
  hasSeen,
  isNewWorkspace,
  LANDING_PROMO_KEY,
  markSeen,
  NEW_WORKSPACE_WINDOW_MS,
  WELCOME_BONUS_CREDITS,
} from "@/lib/promo/welcome-bonus";

const DAY = 24 * 60 * 60 * 1000;

function withStorage<T>(store: Storage | (() => never), run: () => T): T {
  const g = globalThis as unknown as { window?: unknown; localStorage?: unknown };
  const prevWindow = g.window;
  const localStorage = typeof store === "function" ? new Proxy({}, { get: store }) : store;
  g.window = { localStorage };
  try {
    return run();
  } finally {
    g.window = prevWindow;
  }
}

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size;
    },
  };
}

test("the promo is a 1,000 credit bonus, matching the signup_bonus trigger", () => {
  assert.equal(WELCOME_BONUS_CREDITS, 1000);
  const trigger = readFileSync("supabase/migrations/20260908145225_workflow_runtime_compatibility.sql", "utf8");
  assert.match(trigger, /values\(new\.id,1000,'signup_bonus'/);
});

test("isNewWorkspace accepts recent accounts only", () => {
  const now = Date.parse("2026-09-14T12:00:00Z");
  assert.equal(isNewWorkspace(new Date(now - 1000).toISOString(), now), true);
  assert.equal(isNewWorkspace(new Date(now - 6 * DAY).toISOString(), now), true);
  assert.equal(isNewWorkspace(new Date(now - 8 * DAY).toISOString(), now), false);
  assert.equal(isNewWorkspace(new Date(now + DAY).toISOString(), now), false, "clock skew into the future is not new");
  assert.equal(isNewWorkspace(null, now), false, "demo mode has no workspace");
  assert.equal(isNewWorkspace("not a date", now), false);
  assert.equal(NEW_WORKSPACE_WINDOW_MS, 7 * DAY);
});

test("hasSeen/markSeen round-trip through localStorage", () => {
  withStorage(memoryStorage(), () => {
    assert.equal(hasSeen(LANDING_PROMO_KEY), false);
    markSeen(LANDING_PROMO_KEY);
    assert.equal(hasSeen(LANDING_PROMO_KEY), true);
    assert.equal(hasSeen(APP_WELCOME_KEY), false, "keys are independent");
  });
});

test("blocked storage counts as seen so the promo never loops", () => {
  const throwing = () => {
    throw new Error("SecurityError");
  };
  withStorage(throwing, () => {
    assert.equal(hasSeen(LANDING_PROMO_KEY), true);
    assert.doesNotThrow(() => markSeen(LANDING_PROMO_KEY));
  });
});

test("server render (no window) never shows the promo", () => {
  assert.equal(hasSeen(LANDING_PROMO_KEY), true);
});

test("the in-app dialog carries the promised copy and is mounted for new users only", () => {
  const modal = readFileSync("src/components/promo/welcome-bonus-modal.tsx", "utf8");
  assert.match(modal, /Congratulations!/);
  assert.match(modal, /Your \{bonus\} credits are ready — have fun automating your workflows\./);
  assert.doesNotMatch(modal, /<Icon /, "the dialog leads with the number, not a decorative icon");
  assert.match(modal, /ConfettiBurst/);
  assert.match(modal, /markSeen\(APP_WELCOME_KEY\)/);

  const layout = readFileSync("src/app/app/layout.tsx", "utf8");
  assert.match(layout, /<WelcomeBonusModal eligible=\{isNewWorkspace\(ctx\.workspaceCreatedAt\)\} \/>/);

  const workspace = readFileSync("src/lib/workspace.ts", "utf8");
  assert.match(workspace, /select\("id, name, plan, created_at"\)/);
});

test("the landing offer waits 4.5 seconds before a decorated celebration", () => {
  const modal = readFileSync("src/components/promo/landing-promo-modal.tsx", "utf8");
  assert.match(modal, /const OPEN_DELAY_MS = 4_500/);
  assert.match(modal, /ConfettiBurst/);
  assert.match(modal, /markSeen\(LANDING_PROMO_KEY\)/);
  assert.match(modal, /href="\/signup"/);
  assert.doesNotMatch(modal, /name="sparkles"/, "the banner uses ambient CSS sparkles instead of an AI icon");
  assert.match(modal, /sparkleEight/);
  assert.match(modal, /landing-promo-modal\.module\.css/);

  const landing = readFileSync("src/components/landing-space/space-landing.tsx", "utf8");
  assert.match(landing, /<LandingPromoModal \/>/);
});

test("confetti stays out of the way and respects reduced motion", () => {
  const confetti = readFileSync("src/components/promo/confetti.tsx", "utf8");
  assert.match(confetti, /prefers-reduced-motion: reduce/);
  assert.match(confetti, /pointer-events-none fixed inset-0 z-\[110\]/);
});
