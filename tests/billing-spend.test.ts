import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeSpend } from "@/lib/billing/spend";
import { BILLING_PLANS } from "@/lib/billing/plans";

test("spend summary groups real ledger debits and ignores grants", () => {
  const spend = summarizeSpend([
    { reason: "signup_bonus", delta: 1000 },
    { reason: "plan_grant", delta: 10_000 },
    { reason: "video_ugc", delta: -40 },
    { reason: "video_shortform", delta: -25 },
    { reason: "image_generation", delta: -5 },
    { reason: "workflow_run", delta: -2 },
    { reason: "workflow_run", delta: -2 },
    { reason: "brand_research", delta: -10 },
    { reason: "refund", delta: 25 },
  ], "This billing cycle");

  assert.equal(spend.periodLabel, "This billing cycle");
  assert.deepEqual(spend.categories, [
    { key: "videos", label: "Videos", credits: 65, count: 2 },
    { key: "images", label: "Images", credits: 5, count: 1 },
    { key: "workflows", label: "Workflow runs", credits: 4, count: 2 },
    { key: "other", label: "Other", credits: 10, count: 1 },
  ]);
  assert.equal(spend.refunded, 25);
  assert.equal(spend.total, 59);
});

test("spend summary is empty for a workspace that only holds its opening grant", () => {
  const spend = summarizeSpend([{ reason: "signup_bonus", delta: 1000 }], "Last 30 days");
  assert.deepEqual(spend, { periodLabel: "Last 30 days", total: 0, refunded: 0, categories: [] });
});

test("only paid plans advertise a monthly credit refill", () => {
  const free = BILLING_PLANS.find((plan) => plan.id === "free")!;
  const pro = BILLING_PLANS.find((plan) => plan.id === "pro")!;
  assert.equal(free.features[0], "1,000 credits to start");
  assert.equal(pro.features[0], "10,000 credits / month");
});
