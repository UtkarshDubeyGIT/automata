import assert from "node:assert/strict";
import test from "node:test";

import { nextCronOccurrence } from "../src/lib/workflows/schedule";

test("cron schedules honor the workspace timezone and weekday range", () => {
  const next = nextCronOccurrence("0 9 * * 1-5", "Asia/Kolkata", new Date("2026-08-28T05:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-08-31T03:30:00.000Z");
});

test("step schedules find the next matching minute", () => {
  const next = nextCronOccurrence("*/15 * * * *", "UTC", new Date("2026-08-31T10:01:22.000Z"));
  assert.equal(next.toISOString(), "2026-08-31T10:15:00.000Z");
});
