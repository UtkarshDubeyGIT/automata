import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dueSlot,
  isScheduleDue,
  nextSlots,
  safeTimeZone,
  scheduleLabel,
  scheduleSlot,
  scheduleSpec,
} from "@/lib/workflows/blocks";
import { scheduleKey } from "@/lib/workflows/claim";
import { repairSchedules } from "@/lib/workflows/repair";
import { validateGraph } from "@/lib/workflows/validate";
import type { StepDef } from "@/lib/workflows/types";

/**
 * Schedules answer a SLOT, not a boolean, because the slot is the trigger's
 * idempotency key. Everything below is really one property: the same slot is
 * fired exactly once, no matter when the beat happens to run.
 */

const daily = (hour: number): StepDef => ({ type: "schedule_trigger", cadence: "daily", hour });
const weekly = (weekday: number, hour: number): StepDef => ({
  type: "schedule_trigger",
  cadence: "weekly",
  weekday,
  hour,
});
const hourly: StepDef = { type: "schedule_trigger", cadence: "hourly" };

test("a corrupt lastFiredAt does not fire every beat", () => {
  const now = new Date("2026-08-27T10:00:00Z");
  // It used to return TRUE outright, so one bad timestamp fired the workflow
  // every 15 minutes at 2 credits a go until somebody noticed.
  const slot = dueSlot(daily(9), "not a date", now);
  assert.ok(slot, "should fire once for the current slot");
  // And having fired, it writes a good value and stops.
  assert.equal(dueSlot(daily(9), slot!.toISOString(), now), null);
});

test("twice in one day fires once", () => {
  const step = daily(9);
  const first = dueSlot(step, undefined, new Date("2026-08-27T09:00:00Z"));
  assert.equal(first?.toISOString(), "2026-08-27T09:00:00.000Z");
  // Later the same day, already fired: nothing owed.
  assert.equal(dueSlot(step, first!.toISOString(), new Date("2026-08-27T18:00:00Z")), null);
  // Next day: owed again.
  const second = dueSlot(step, first!.toISOString(), new Date("2026-08-28T09:30:00Z"));
  assert.equal(second?.toISOString(), "2026-08-28T09:00:00.000Z");
});

test("before the hour, nothing is owed for today", () => {
  const yesterday = dueSlot(daily(9), undefined, new Date("2026-08-27T03:00:00Z"));
  assert.equal(yesterday?.toISOString(), "2026-08-26T09:00:00.000Z");
});

test("a beat that runs late still fires the slot it missed, exactly once", () => {
  const step = daily(9);
  const lastFired = "2026-08-25T09:00:00.000Z";
  // The beat was down all of the 26th and comes back at 23:00 on the 26th.
  const slot = dueSlot(step, lastFired, new Date("2026-08-26T23:00:00Z"));
  assert.equal(slot?.toISOString(), "2026-08-26T09:00:00.000Z");
  // Two overlapping beats compute the same key, so the unique index collapses
  // them into one run.
  const other = dueSlot(step, lastFired, new Date("2026-08-26T23:00:05Z"));
  assert.equal(scheduleKey(slot!), scheduleKey(other!));
  assert.equal(scheduleKey(slot!), "schedule:2026-08-26T09:00:00.000Z");
});

test("a week of downtime does not skip a week", () => {
  const step = weekly(1, 9); // Monday 09:00
  // 2026-08-24 is a Monday. The beat is down all Monday and returns Tuesday.
  const slot = dueSlot(step, "2026-08-17T09:00:00.000Z", new Date("2026-08-25T11:00:00Z"));
  // The old check demanded now.getUTCDay() === weekday, so Tuesday returned
  // false and the run waited a further week.
  assert.equal(slot?.toISOString(), "2026-08-24T09:00:00.000Z");
});

test("weekly does not re-fire once its slot is recorded", () => {
  const step = weekly(1, 9);
  assert.equal(dueSlot(step, "2026-08-24T09:00:00.000Z", new Date("2026-08-25T11:00:00Z")), null);
});

test("hourly fires once per hour", () => {
  const first = dueSlot(hourly, undefined, new Date("2026-08-27T10:05:00Z"));
  assert.equal(first?.toISOString(), "2026-08-27T10:00:00.000Z");
  assert.equal(dueSlot(hourly, first!.toISOString(), new Date("2026-08-27T10:59:30Z")), null);
  const next = dueSlot(hourly, first!.toISOString(), new Date("2026-08-27T11:00:10Z"));
  assert.equal(next?.toISOString(), "2026-08-27T11:00:00.000Z");
});

test("a workspace timezone moves the day boundary", () => {
  const step = daily(9);
  // 09:00 in Kolkata is 03:30 UTC.
  const kolkata = scheduleSlot(step, new Date("2026-08-27T04:00:00Z"), "Asia/Kolkata");
  assert.equal(kolkata?.toISOString(), "2026-08-27T03:30:00.000Z");
  // At the same instant, a UTC workspace has not reached 09:00 yet, so its
  // most recent slot is still yesterday's.
  const utc = scheduleSlot(step, new Date("2026-08-27T04:00:00Z"), "UTC");
  assert.equal(utc?.toISOString(), "2026-08-26T09:00:00.000Z");
});

test("a timezone west of UTC also shifts", () => {
  // 09:00 New York in August (EDT, UTC-4) is 13:00 UTC.
  const slot = scheduleSlot(daily(9), new Date("2026-08-27T14:00:00Z"), "America/New_York");
  assert.equal(slot?.toISOString(), "2026-08-27T13:00:00.000Z");
});

test("an unknown timezone falls back to UTC rather than throwing", () => {
  assert.equal(safeTimeZone("Mars/Olympus"), "UTC");
  assert.equal(safeTimeZone(""), "UTC");
  assert.equal(safeTimeZone(null), "UTC");
  assert.equal(safeTimeZone("Asia/Kolkata"), "Asia/Kolkata");
  assert.doesNotThrow(() => scheduleSlot(daily(9), new Date(), "Mars/Olympus"));
});

test("isScheduleDue still answers the boolean question", () => {
  assert.equal(isScheduleDue(daily(9), undefined, new Date("2026-08-27T10:00:00Z")), true);
  assert.equal(
    isScheduleDue(daily(9), "2026-08-27T09:00:00.000Z", new Date("2026-08-27T10:00:00Z")),
    false,
  );
});

// ---------------------------------------------------------------------------
// Intervals and multi-day weeks
//
// The three cadences above cover "every day", "every Monday" and "every hour".
// Everything below is the routine a user could describe but not set: alternate
// days, once every three days, Monday plus Saturday and Sunday. The property
// under test is the same one — a slot fires exactly once — so these read as
// more cases of it, not a second mechanism.
// ---------------------------------------------------------------------------

const everyNDays = (every: number, hour: number, start?: string): StepDef => ({
  type: "schedule_trigger",
  cadence: "daily",
  every,
  hour,
  ...(start ? { start } : {}),
});

const onDays = (weekdays: number[], hour: number): StepDef => ({
  type: "schedule_trigger",
  cadence: "weekly",
  weekdays,
  hour,
});

test("alternate days fires every other day, counted from its start", () => {
  // 2026-08-24 is a Monday.
  const step = everyNDays(2, 9, "2026-08-24");
  const monday = dueSlot(step, undefined, new Date("2026-08-24T09:30:00Z"));
  assert.equal(monday?.toISOString(), "2026-08-24T09:00:00.000Z");
  // Tuesday is off the beat: still Monday's slot, and Monday's already fired.
  assert.equal(dueSlot(step, monday!.toISOString(), new Date("2026-08-25T12:00:00Z")), null);
  const wednesday = dueSlot(step, monday!.toISOString(), new Date("2026-08-26T09:00:00Z"));
  assert.equal(wednesday?.toISOString(), "2026-08-26T09:00:00.000Z");
});

test("once every three days keeps a three-day rhythm", () => {
  const step = everyNDays(3, 9, "2026-08-24");
  assert.deepEqual(
    nextSlots(step, new Date("2026-08-24T10:00:00Z"), 3).map((d) => d.toISOString()),
    ["2026-08-27T09:00:00.000Z", "2026-08-30T09:00:00.000Z", "2026-09-02T09:00:00.000Z"],
  );
});

test("an interval that was missed fires the slot it owed, not today", () => {
  const step = everyNDays(3, 9, "2026-08-24");
  // Down from the 27th; back up on the 29th, which is NOT on the beat.
  const slot = dueSlot(step, "2026-08-24T09:00:00.000Z", new Date("2026-08-29T15:00:00Z"));
  assert.equal(slot?.toISOString(), "2026-08-27T09:00:00.000Z");
  assert.equal(scheduleKey(slot!), "schedule:2026-08-27T09:00:00.000Z");
});

test("nothing is owed before the interval's start date", () => {
  assert.equal(dueSlot(everyNDays(2, 9, "2026-09-01"), undefined, new Date("2026-08-27T10:00:00Z")), null);
});

test("an interval with no start date still has a fixed rhythm", () => {
  // Anchoring on "today" would make every day divisible by itself and fire
  // daily — the exact over-firing this feature exists to end.
  const step = everyNDays(2, 9);
  const first = dueSlot(step, undefined, new Date("2026-08-27T10:00:00Z"));
  assert.ok(first);
  assert.equal(dueSlot(step, first!.toISOString(), new Date("2026-08-28T10:00:00Z")), null);
});

test("a week can name more than one day", () => {
  const step = onDays([1, 6, 0], 9); // Monday, Saturday, Sunday
  assert.deepEqual(
    nextSlots(step, new Date("2026-08-27T10:00:00Z"), 4).map((d) => d.toISOString()),
    [
      "2026-08-29T09:00:00.000Z", // Sat
      "2026-08-30T09:00:00.000Z", // Sun
      "2026-08-31T09:00:00.000Z", // Mon
      "2026-09-05T09:00:00.000Z", // Sat
    ],
  );
});

test("a multi-day week fires each of its days exactly once", () => {
  const step = onDays([1, 6, 0], 9);
  const sat = dueSlot(step, undefined, new Date("2026-08-29T09:05:00Z"));
  assert.equal(sat?.toISOString(), "2026-08-29T09:00:00.000Z");
  assert.equal(dueSlot(step, sat!.toISOString(), new Date("2026-08-29T20:00:00Z")), null);
  const sun = dueSlot(step, sat!.toISOString(), new Date("2026-08-30T09:00:00Z"));
  assert.equal(sun?.toISOString(), "2026-08-30T09:00:00.000Z");
});

test("the original single weekday is still read when no list is present", () => {
  // Live rows saved before multi-day weeks existed have `weekday`, not
  // `weekdays`, and must keep meaning exactly what they always meant.
  const legacy: StepDef = { type: "schedule_trigger", cadence: "weekly", weekday: 3, hour: 9 };
  assert.deepEqual(scheduleSpec(legacy).weekdays, [3]);
  assert.equal(
    dueSlot(legacy, undefined, new Date("2026-08-26T09:30:00Z"))?.toISOString(),
    "2026-08-26T09:00:00.000Z",
  );
});

test("hourly can skip hours", () => {
  const step: StepDef = { type: "schedule_trigger", cadence: "hourly", every: 6 };
  const slot = dueSlot(step, undefined, new Date("2026-08-27T13:20:00Z"));
  assert.equal(slot?.toISOString(), "2026-08-27T12:00:00.000Z");
  assert.equal(dueSlot(step, slot!.toISOString(), new Date("2026-08-27T17:59:00Z")), null);
  assert.equal(
    dueSlot(step, slot!.toISOString(), new Date("2026-08-27T18:00:00Z"))?.toISOString(),
    "2026-08-27T18:00:00.000Z",
  );
});

test("an interval respects the workspace timezone", () => {
  // 09:00 in Kolkata is 03:30 UTC, so the 26th's slot lands before 09:00 UTC.
  const step = everyNDays(2, 9, "2026-08-24");
  const slot = scheduleSlot(step, new Date("2026-08-26T04:00:00Z"), "Asia/Kolkata");
  assert.equal(slot?.toISOString(), "2026-08-26T03:30:00.000Z");
});

test("nextSlots agrees with the slot the sweep would fire", () => {
  // The editor's promise and the sweep's behaviour are the same arithmetic;
  // if they ever drift, the preview lies about what will happen.
  for (const step of [everyNDays(3, 9, "2026-08-24"), onDays([2, 5], 14), daily(9)]) {
    const now = new Date("2026-08-27T10:00:00Z");
    const upcoming = nextSlots(step, now, 1)[0];
    const after = new Date(upcoming.getTime() + 60_000);
    assert.equal(scheduleSlot(step, after)?.toISOString(), upcoming.toISOString());
  }
});

// ---------------------------------------------------------------------------
// How a schedule reads
// ---------------------------------------------------------------------------

test("a set of days reads as a phrase, not a list of seven", () => {
  assert.equal(scheduleLabel(onDays([1, 2, 3, 4, 5], 9)), "Every weekday at 9:00 AM");
  assert.equal(scheduleLabel(onDays([0, 6], 9)), "Every Saturday and Sunday at 9:00 AM");
  assert.equal(scheduleLabel(onDays([0, 1, 2, 3, 4, 5, 6], 9)), "Every day at 9:00 AM");
  assert.equal(scheduleLabel(onDays([1, 6, 0], 9)), "Every Monday, Saturday and Sunday at 9:00 AM");
  assert.equal(scheduleLabel(onDays([1], 9)), "Every Monday at 9:00 AM");
});

test("an interval reads the way it was asked for", () => {
  assert.equal(scheduleLabel(everyNDays(1, 9)), "Every day at 9:00 AM");
  assert.equal(scheduleLabel(everyNDays(2, 9)), "Every other day at 9:00 AM");
  assert.equal(scheduleLabel(everyNDays(3, 18)), "Every 3 days at 6:00 PM");
  assert.equal(scheduleLabel({ type: "schedule_trigger", cadence: "hourly" }), "Every hour");
  assert.equal(
    scheduleLabel({ type: "schedule_trigger", cadence: "hourly", every: 6 }),
    "Every 6 hours",
  );
});

// ---------------------------------------------------------------------------
// What the compiler is allowed to say
// ---------------------------------------------------------------------------

const wrap = (trigger: StepDef) => ({
  start: "t",
  steps: { t: { ...trigger, next: null } },
});

test("days on a daily cadence are rejected rather than silently ignored", () => {
  // Left alone this runs EVERY day: the days are simply not read.
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "daily", weekdays: [1, 6] })),
    /weekly/,
  );
});

test("an out-of-range interval is rejected", () => {
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "daily", every: 45 })),
    /1 to 30/,
  );
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "hourly", every: 40 })),
    /1 to 23/,
  );
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "daily", every: 2.5 })),
    /whole number/,
  );
});

test("a weekly cadence cannot also carry an interval", () => {
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "weekly", weekdays: [1], every: 2 })),
    /every 14 days/,
  );
});

test("an empty set of days is rejected", () => {
  assert.throws(
    () => validateGraph(wrap({ type: "schedule_trigger", cadence: "weekly", weekdays: [] })),
    /at least one day/,
  );
});

test("every shape the editor writes passes validation", () => {
  assert.doesNotThrow(() => validateGraph(wrap(onDays([1, 6, 0], 9))));
  assert.doesNotThrow(() => validateGraph(wrap(everyNDays(2, 9, "2026-08-24"))));
  assert.doesNotThrow(() => validateGraph(wrap(everyNDays(1, 9))));
  assert.doesNotThrow(() => validateGraph(wrap({ type: "schedule_trigger", cadence: "hourly", every: 6 })));
  assert.doesNotThrow(() => validateGraph(wrap(daily(9))));
  assert.doesNotThrow(() => validateGraph(wrap(weekly(1, 9))));
});

test("a compiled schedule is repaired into the one it meant", () => {
  // The model reached for `weekdays` and left the cadence behind.
  const fixed = repairSchedules(wrap({ type: "schedule_trigger", cadence: "daily", weekdays: [1, 6] }));
  assert.equal(fixed.steps.t.cadence, "weekly");
  assert.equal(fixed.steps.t.every, undefined);
  assert.doesNotThrow(() => validateGraph(fixed));

  // An interval with no anchor gets today's date, because the model is never
  // told what today is.
  const anchored = repairSchedules(wrap({ type: "schedule_trigger", cadence: "daily", every: 3, hour: 9 }));
  assert.match(String(anchored.steps.t.start), /^\d{4}-\d{2}-\d{2}$/);

  // Idempotent: repairing an already-right graph changes nothing.
  assert.deepEqual(repairSchedules(anchored), anchored);
});
