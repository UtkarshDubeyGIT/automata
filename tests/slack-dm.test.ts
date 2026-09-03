import { strict as assert } from "node:assert";
import { test } from "node:test";
import * as platforms from "@/lib/social/platforms";

test("a Slack DM member id takes precedence over a channel", () => {
  const target = (platforms as Record<string, unknown>).slackTarget;
  assert.equal(typeof target, "function", "slackTarget should exist");
  assert.equal(
    (target as (options: Record<string, string>) => string)({ channel: "#general", dmUser: "U012ABCDEF" }),
    "U012ABCDEF",
  );
});

test("Slack delivery still supports existing channel workflows", () => {
  const target = (platforms as Record<string, unknown>).slackTarget;
  assert.equal(typeof target, "function", "slackTarget should exist");
  assert.equal((target as (options: Record<string, string>) => string)({ channel: "#growth" }), "#growth");
});

test("simplified Slack step with DM member and AI instruction requires no extra setup", async () => {
  const { missingSetup } = await import("@/lib/workflows/validate");
  const missing = missingSetup({
    type: "social_post",
    platform: "slack",
    instruction: "Summarize this week's growth metrics for the team",
    options: { dmUser: "U012ABCDEF" },
  });
  assert.deepEqual(missing, []);
});

test("Slack step without DM user or channel reports missing destination", async () => {
  const { missingSetup } = await import("@/lib/workflows/validate");
  const missing = missingSetup({
    type: "social_post",
    platform: "slack",
    instruction: "Summarize metrics",
    options: {},
  });
  assert.ok(missing.includes("Slack posts need a channel or DM member ID"));
});

test("inspector exposes Slack channel configuration and variable-enabled messages", async () => {
  const { readFileSync } = await import("node:fs");
  const inspector = readFileSync("src/app/(app)/workflows/[id]/inspector.tsx", "utf8");
  assert.match(inspector, /isSlack \? \(\s*<SlackStepFields/);
  assert.match(inspector, /function SlackDmField/);
  assert.match(inspector, /function SlackStepFields/);
  assert.match(inspector, /function SlackChannelField/);
  assert.match(inspector, /\/api\/integrations\/slack\/channels/);
  assert.match(inspector, /<TemplateInput/);
  assert.match(inspector, /Message/);
});
