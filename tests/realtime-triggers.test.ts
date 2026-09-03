import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { TRIGGERS } from "@/lib/workflows/registry";

/**
 * The push half of an app-event trigger, checked against the shapes Composio
 * actually publishes.
 *
 * Everything here was verified against the live v3 catalog (`composio triggers
 * list <toolkit>` / `composio triggers info <slug>`) and every case below is a
 * defect that was found that way rather than an invented one. They share a
 * failure mode that makes them almost impossible to notice from the editor: the
 * Test button feeds the trigger its canned `sample` and the sweep feeds it
 * `mapRecord`, so BOTH stay correct while only genuine pushed events are
 * wrong. The automation looks healthy, runs on schedule, and quietly does the
 * wrong thing — or the right thing with empty inputs.
 *
 * The payload fixtures are the `payload.properties` of the real trigger types,
 * not guesses; if Composio reshapes one, these should be re-derived from the
 * catalog rather than patched to match the code.
 */

const PAYLOADS: Record<string, Record<string, unknown>> = {
  // GITHUB_ISSUE_ADDED_EVENT — flat, and spells two fields differently from
  // the REST listing (`description` not `body`, `createdBy` not `user.login`).
  NEW_GITHUB_ISSUE: {
    action: "opened",
    createdAt: "2026-08-20T09:00:00Z",
    createdBy: "jordan-dev",
    description: "Tapping Checkout does nothing on iOS 19 Safari.",
    issue_id: 9912345,
    number: 412,
    title: "Checkout button unresponsive on mobile Safari",
    url: "https://github.com/acme/store/issues/412",
  },
  // GMAIL_NEW_GMAIL_MESSAGE — the message fields are flat AND there is a
  // `payload` key holding the raw MIME tree.
  NEW_GMAIL_EMAIL: {
    id: "19a2f4",
    message_id: "msg_19a2f4",
    message_text: "Hi — we're evaluating tools for a 40-person team…",
    preview: "Hi — we're evaluating tools for a 40-person team…",
    sender: "priya@northwind.dev",
    subject: "Question about your enterprise plan",
    thread_id: "t1",
    payload: { mimeType: "multipart/alternative", headers: [], parts: [] },
  },
  // SLACK_CHANNEL_MESSAGE_RECEIVED
  NEW_SLACK_MESSAGE: {
    channel: "C0123456789",
    channel_type: "channel",
    text: "Heads up — a customer just asked whether we support SSO.",
    ts: "1786550400.001200",
    user: "U04ALEXC",
  },
  // GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER — scalar `start_time`
  // where events.list nests `start.dateTime`, and an organizer, not attendees.
  NEW_CALENDAR_EVENT: {
    calendar_id: "primary",
    end_time: "2026-08-14T16:00:00Z",
    event_id: "evt_7c21",
    organizer_email: "priya@northwind.dev",
    start_time: "2026-08-14T15:00:00Z",
    summary: "Demo — Northwind",
  },
  // LINEAR_ISSUE_CREATED_TRIGGER — the issue is under `data`.
  NEW_LINEAR_ISSUE: {
    action: "create",
    type: "Issue",
    url: "https://linear.app/acme/issue/ENG-142",
    data: {
      identifier: "ENG-142",
      title: "Checkout retries twice on a failed card",
      description: "Repro: use a declined test card; the charge is attempted twice.",
      state: { name: "Todo" },
    },
  },
};

test("a pushed event fills every field its trigger promises", () => {
  /*
   * The one property that matters: a step downstream reading
   * {{steps.<trigger>.event.<field>}} gets something. Gmail failed this on all
   * four fields (the unwrap matched the MIME `payload` and threw the real ones
   * away) and GitHub failed it on body and author — so "AI, triage this issue"
   * ran on an empty body and still reported success.
   */
  for (const [slug, payload] of Object.entries(PAYLOADS)) {
    const spec = TRIGGERS[slug];
    assert.ok(spec?.realtime?.mapEvent, `${slug} has no realtime mapEvent`);
    const event = spec.realtime.mapEvent(payload);
    for (const field of Object.keys(spec.event)) {
      assert.ok(
        String(event[field] ?? "").trim(),
        `${slug}: pushed event leaves '${field}' empty`,
      );
    }
  }
});

test("a pushed event and a polled record agree on what they mean", () => {
  // Same issue, one delivered by webhook and one read from the listing. If
  // these disagree, an automation changes behaviour the moment real time is
  // arranged for it — which is exactly what the field renames caused.
  const pushed = TRIGGERS.NEW_GITHUB_ISSUE.realtime!.mapEvent!(PAYLOADS.NEW_GITHUB_ISSUE);
  const polled = TRIGGERS.NEW_GITHUB_ISSUE.mapRecord!({
    number: 412,
    title: "Checkout button unresponsive on mobile Safari",
    body: "Tapping Checkout does nothing on iOS 19 Safari.",
    user: { login: "jordan-dev" },
  });
  assert.deepEqual(pushed, polled);
});

test("a trigger that can push declares the settings it needs to push", () => {
  /*
   * `needs` mirrors the trigger type's own required config. Linear's issue
   * trigger requires team_id and nothing here offered one, so `missingConfig`
   * reported it on every single enable and real time was simply unreachable
   * for Linear — silently, because falling back to polling is not an error.
   */
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    for (const key of spec.realtime?.needs ?? []) {
      assert.ok(
        spec.watch?.some((w) => w.key === key),
        `${slug} needs watch_${key} for real time but offers no field to enter it`,
      );
      const config = spec.realtime!.config?.({ [key]: "value" }) ?? {};
      assert.ok(
        key in config,
        `${slug} declares '${key}' required but never sends it as instance config`,
      );
    }
  }
});

test("an ambiguous trigger name resolves to nothing rather than to the wrong event", async () => {
  /*
   * Google Calendar shipped this. None of the three slugs guessed for "a new
   * calendar event" existed, so resolution fell through to the loose word
   * match — and CALENDAR + EVENT (NEW is too short to survive the filter)
   * matches six of the toolkit's seven trigger types. It took the first, which
   * was "Event Canceled or Deleted", and because that type accepts the same
   * `calendarId` the subscription succeeded: "when an event is added" became
   * "when an event is cancelled", with nothing on screen saying so.
   *
   * Falling back to polling is the honest answer to a tie, and the caller
   * already records a reason for it that the editor now shows.
   */
  const catalog = [
    { slug: "GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER", config: {} },
    { slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER", config: {} },
    { slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER", config: {} },
  ];
  mock.module("@/lib/social/composio", {
    namedExports: {
      composioApi: async () => ({ items: catalog }),
      PLATFORMS: [],
    },
  });
  const { resolveTriggerType } = await import("@/lib/social/composio-triggers");

  assert.equal(
    await resolveTriggerType("googlecalendar", ["GOOGLECALENDAR_NEW_CALENDAR_EVENT"]),
    null,
    "an ambiguous name must not be guessed at",
  );

  // The reason the loose match exists at all — a rename — still resolves,
  // because a renamed trigger matches once and not six times.
  const renamed = await resolveTriggerType("googlecalendar", [
    "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CANCELED_TRIGGER",
  ]);
  assert.equal(renamed?.slug, "GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER");

  // And an exact name is never subject to any of this.
  const exact = await resolveTriggerType("googlecalendar", [
    "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER",
  ]);
  assert.equal(exact?.slug, "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER");
});
