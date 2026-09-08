import { strict as assert } from "node:assert";
import { test } from "node:test";
import { MIN_POLL_MINUTES, pollMinutes, TRIGGERS } from "@/lib/workflows/registry";
import { nodeSpec } from "@/lib/workflows/blocks";
import { TEMPLATES } from "@/lib/workflows/templates";
import type { FieldSpec } from "@/lib/workflows/blocks";

/**
 * How often a polled trigger is checked — a setting that existed and could not
 * be reached.
 *
 * The editor's "Check every (minutes)" box is gated on POLL_ONLY_TRIGGERS,
 * which excluded `SIMULATED_APPS`. Google Business Profile is in that set
 * permanently (Composio has no toolkit for it) yet is polled for real through
 * `nativePoll()`, and it is the ONLY trigger with no real-time watch — so the
 * exclusion emptied the list, the field never rendered for anything, and the
 * one trigger that can only ever be polled was the one denied the control.
 * Google reviews were checked hourly with no way to say otherwise.
 *
 * The floor is not a preference: `deploy/systemd/zidane-cron.timer` fires every
 * 15 minutes, so a smaller number describes something that cannot happen.
 */

/** The cadence field as the inspector will actually see it. */
function cadenceField(): FieldSpec {
  const spec = nodeSpec("app_event_trigger");
  assert.ok(spec, "the trigger node type must exist");
  const field = spec.fields?.find((f) => f.key === "interval_minutes");
  assert.ok(field, "the cadence field must exist");
  return field;
}

test("the Google review trigger is offered the cadence box", () => {
  const shown = cadenceField().showIf;
  assert.ok(shown && Array.isArray(shown.equals), "gated on a list of trigger slugs");
  assert.ok(
    shown.equals.includes("NEW_GOOGLE_REVIEW"),
    "the one trigger that can only ever be polled must be able to set its cadence",
  );
});

test("a trigger that can be pushed is still not offered one", () => {
  // Where a real-time watch exists we subscribe, and polling is the silent
  // fallback — a box there advertises the slower path as the plan.
  const shown = cadenceField().showIf;
  const equals = shown!.equals as string[];
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    if (!spec.realtime) continue;
    assert.ok(!equals.includes(slug), `${slug} pushes, so it needs no cadence box`);
  }
  assert.equal(equals.length, 1, "exactly one poll-only trigger today");
});

test("the box carries the floor rather than merely mentioning it", () => {
  const field = cadenceField();
  assert.equal(field.min, MIN_POLL_MINUTES, "enforced, not advisory");
  assert.match(field.hint ?? "", new RegExp(String(MIN_POLL_MINUTES)), "and said out loud");
});

test("a cadence below the floor is raised to it", () => {
  // The beat cannot go faster, so 5 would be a promise nothing can keep.
  assert.equal(pollMinutes({ interval_minutes: 5 }), MIN_POLL_MINUTES);
  assert.equal(pollMinutes({ interval_minutes: 1 }), MIN_POLL_MINUTES);
  assert.equal(pollMinutes({ interval_minutes: MIN_POLL_MINUTES }), MIN_POLL_MINUTES);
});

test("an unset cadence is an hour, which is not the same as one set too low", () => {
  // Absent means "never chosen" and keeps the old default; zero and nonsense
  // are the same statement. Collapsing these into the floor would silently
  // speed up every automation that never set one.
  assert.equal(pollMinutes({}), 60);
  assert.equal(pollMinutes({ interval_minutes: 0 }), 60);
  assert.equal(pollMinutes({ interval_minutes: "soon" }), 60);
  assert.equal(pollMinutes({ interval_minutes: -30 }), 60);
});

test("a cadence above the floor is left exactly alone", () => {
  assert.equal(pollMinutes({ interval_minutes: 30 }), 30);
  assert.equal(pollMinutes({ interval_minutes: 60 }), 60);
  assert.equal(pollMinutes({ interval_minutes: 720 }), 720);
});

test("the cadence shown and the cadence obeyed are one number", () => {
  /*
   * The regression a floor invites: the sweep clamps, the card does not, and
   * the trigger advertises "every 5 min" while the poller keeps to 15. Four
   * call sites used to compute this separately and agreed only by coincidence
   * — sweep.ts, blocks.ts's summary, limitations.ts and display.ts now share
   * `pollMinutes`, so this is one answer by construction.
   */
  const spec = nodeSpec("app_event_trigger");
  const summary = spec!.summary!({
    type: "app_event_trigger",
    event: "NEW_GOOGLE_REVIEW",
    interval_minutes: 5,
  });
  assert.ok(
    !summary.includes("every 5 min"),
    "must not advertise a cadence nothing honours",
  );
  assert.match(summary, /checks every 15 min/);

  // And a pushed trigger still says nothing about cadence at all.
  const pushed = spec!.summary!({
    type: "app_event_trigger",
    event: "NEW_SLACK_MESSAGE",
    interval_minutes: 5,
  });
  assert.ok(!pushed.includes("checks"), "a real-time trigger has no cadence to report");
});

test("every shipped template already respects the floor", () => {
  // If one did not, this change would silently slow it down.
  for (const [slug, tpl] of Object.entries(TEMPLATES)) {
    for (const [id, step] of Object.entries(tpl.graph.steps)) {
      if (step.type !== "app_event_trigger") continue;
      const raw = Number(step.interval_minutes);
      if (!Number.isFinite(raw) || raw <= 0) continue;
      assert.ok(
        raw >= MIN_POLL_MINUTES,
        `${slug}/${id} asks for ${raw} minutes, below the ${MIN_POLL_MINUTES} floor`,
      );
    }
  }
});
