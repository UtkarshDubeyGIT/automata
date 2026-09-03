import { strict as assert } from "node:assert";
import { test } from "node:test";
import { triggerInfo, scheduleText } from "@/lib/workflows/display";
import type { WorkflowConfig } from "@/lib/workflows/types";

/**
 * "Runs in real time" is a promise, and it was being made for two different
 * things.
 *
 * Composio types every trigger `webhook` (a genuine provider push) or `poll`
 * (Composio checking the account on its own interval, default 2 minutes, and
 * forwarding what it finds). Both are subscribed identically, both are enormous
 * improvements on our hourly sweep, and the header called both instant —
 * which Gmail and Google Calendar cannot honour, since polls are the only
 * trigger types either publishes. Verified against the live catalog:
 * GITHUB_ISSUE_ADDED_EVENT and SLACK_CHANNEL_MESSAGE_RECEIVED are webhooks,
 * GMAIL_NEW_GMAIL_MESSAGE and GOOGLECALENDAR_..._EVENT_CREATED_TRIGGER are polls.
 */

const config = {
  graph: {
    start: "issue",
    steps: {
      issue: {
        type: "app_event_trigger",
        event: "NEW_GITHUB_ISSUE",
        watch_owner: "vercel",
        watch_repo: "next.js",
        interval_minutes: 60,
        next: null,
      },
    },
  },
} as unknown as WorkflowConfig;

const at = "2026-08-28T00:00:00Z";

test("a provider push and a Composio-side poll are not described the same way", () => {
  const pushed = triggerInfo(config, { realtime: { mode: "realtime", channel: "webhook", at } });
  assert.equal(pushed?.delivery, "realtime");
  assert.equal(pushed?.deliveryChannel, "webhook");

  const forwarded = triggerInfo(config, { realtime: { mode: "realtime", channel: "poll", at } });
  assert.equal(forwarded?.delivery, "realtime");
  assert.equal(forwarded?.deliveryChannel, "poll");
});

test("an automation enabled before the channel was recorded is not relabelled", () => {
  // Rows written before `channel` existed carry no evidence either way, so they
  // keep the old wording rather than being demoted on an assumption.
  const legacy = triggerInfo(config, { realtime: { mode: "realtime", at } });
  assert.equal(legacy?.delivery, "realtime");
  assert.equal(legacy?.deliveryChannel, undefined);
});

test("the one-line cadence stops calling a two-minute poll instant", () => {
  const line = (channel?: "webhook" | "poll") =>
    scheduleText(config, { realtime: { mode: "realtime", channel, at } });

  assert.equal(line("webhook"), "Runs in real time");
  assert.notEqual(line("poll"), "Runs in real time");
  assert.match(line("poll"), /minutes/i);
  // No state at all means not enabled yet — that is the polling sweep, not a
  // subscription, and it must not borrow either phrase.
  assert.match(scheduleText(config), /Checks/);
});
