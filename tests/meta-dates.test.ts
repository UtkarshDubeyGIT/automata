import { strict as assert } from "node:assert";
import { test } from "node:test";
import { metaDateArgs } from "@/lib/analytics/ads";
import type { AnalyticsPeriod } from "@/lib/data/analytics";

/**
 * Every period the UI offers has to reach Meta as something Meta accepts.
 *
 * The bug these pin down shipped in two halves. The loud half sent "last_90d",
 * which is not in Meta's vocabulary, so the 90-day sync was rejected outright.
 * The quiet half was worse: "mtd" and "ytd" fell through to last_30d, so the
 * selector answered "Year to date" with thirty days of numbers and nothing
 * anywhere reported a problem. A wrong number presented confidently is the
 * failure mode worth a test.
 */

/** Meta's closed list, from the live tool schema. Nothing else is accepted. */
const META_PRESETS = [
  "today",
  "yesterday",
  "last_7d",
  "last_30d",
  "this_month",
  "last_month",
  "this_quarter",
  "lifetime",
];

const PERIODS: AnalyticsPeriod[] = ["7d", "30d", "90d", "mtd", "ytd"];

test("no period sends a preset Meta does not have", () => {
  // The invariant the original code broke. Guarding the whole enum rather than
  // one value means a future period cannot reintroduce it.
  for (const period of PERIODS) {
    const preset = metaDateArgs(period).date_preset;
    if (preset === undefined) continue;
    assert.ok(
      META_PRESETS.includes(String(preset)),
      `${period} sends date_preset '${preset}', which Meta rejects`,
    );
  }
});

test("every period sends exactly one kind of window", () => {
  // Sending both is ambiguous, sending neither silently means "lifetime".
  for (const period of PERIODS) {
    const args = metaDateArgs(period);
    const hasPreset = args.date_preset !== undefined;
    const hasRange = args.time_range !== undefined;
    assert.ok(hasPreset !== hasRange, `${period} sends ${hasPreset && hasRange ? "both" : "neither"}`);
  }
});

test("the periods Meta can name use its own preset", () => {
  assert.deepEqual(metaDateArgs("7d"), { date_preset: "last_7d" });
  assert.deepEqual(metaDateArgs("30d"), { date_preset: "last_30d" });
  // Was falling through to last_30d, so "this month" meant "last thirty days".
  assert.deepEqual(metaDateArgs("mtd"), { date_preset: "this_month" });
});

test("90 days is a real 90-day window, not this_quarter", () => {
  // this_quarter is quarter-to-date: on 1 April it would mean a single day.
  const range = metaDateArgs("90d").time_range as { since: string; until: string };
  assert.ok(range, "90d must send an explicit range");
  const days = Math.round(
    (Date.parse(range.until) - Date.parse(range.since)) / 86_400_000,
  );
  assert.equal(days, 90);
});

test("year to date starts on 1 January", () => {
  const range = metaDateArgs("ytd").time_range as { since: string; until: string };
  assert.ok(range, "ytd must send an explicit range");
  assert.match(range.since, /^\d{4}-01-01$/);
  assert.equal(range.since.slice(0, 4), range.until.slice(0, 4));
});

test("explicit dates are the YYYY-MM-DD Meta asks for", () => {
  for (const period of PERIODS) {
    const range = metaDateArgs(period).time_range as { since: string; until: string } | undefined;
    if (!range) continue;
    assert.match(range.since, /^\d{4}-\d{2}-\d{2}$/, `${period} since`);
    assert.match(range.until, /^\d{4}-\d{2}-\d{2}$/, `${period} until`);
    assert.ok(range.since <= range.until, `${period} range runs backwards`);
  }
});
