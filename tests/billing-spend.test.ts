import assert from "node:assert/strict";
import { test } from "node:test";

import { summarizeSpend, summarizeDetailedSpend, runIdsForCharges } from "@/lib/billing/spend";
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
  assert.equal(spend.total, 84);
  assert.equal(spend.total, spend.categories.reduce((sum, c) => sum + c.credits, 0));
});

test("spend summary is empty for a workspace that only holds its opening grant", () => {
  const spend = summarizeSpend([{ reason: "signup_bonus", delta: 1000 }], "Last 30 days");
  assert.deepEqual(spend, { periodLabel: "Last 30 days", total: 0, refunded: 0, categories: [] });
});

test("invite-only Pro advertises its one-time grant", () => {
  const free = BILLING_PLANS.find((plan) => plan.id === "free")!;
  const pro = BILLING_PLANS.find((plan) => plan.id === "pro")!;
  assert.equal(free.features[0], "1,000 credits to start");
  assert.equal(pro.features[0], "10,000 credits once with approval");
});

test("automation totals include runs and steps while keeping standalone charges and refunds distinct", () => {
  const rows = [
    { reason: "workflow_run", delta: -2, ref: "workflow-a", idem_key: "workflow_run:run-1" },
    { reason: "image_generation", delta: -5, idem_key: "wf:run-1:image" },
    { reason: "video_demo", delta: -30, idem_key: "wf:run-2:video" },
    { reason: "workflow_run", delta: -2, ref: "workflow-b", idem_key: "workflow_run:run-3" },
    { reason: "workflow_build", delta: -3, ref: "workflow_build:build-1" },
    { reason: "video_ugc", delta: -40 },
    { reason: "refund", delta: 5 },
    { reason: "plan_grant", delta: 10_000 },
  ];
  assert.deepEqual(runIdsForCharges(rows), ["run-1", "run-2", "run-3"]);
  const result = summarizeDetailedSpend(rows, "Last 30 days",
    new Map([["workflow-a", "Daily report"], ["workflow-b", "Lead routing"]]),
    new Map([["run-1", "workflow-a"], ["run-2", "workflow-a"], ["run-3", "workflow-b"]]));
  assert.equal(result.total, 82);
  assert.equal(result.refunded, 5);
  assert.deepEqual(result.workflows.map(({ name, credits }) => ({ name, credits })), [
    { name: "Daily report", credits: 37 }, { name: "Lead routing", credits: 2 },
  ]);
  assert.deepEqual(result.workflows[0].charges.map(({ label, credits }) => ({ label, credits })), [
    { label: "Runs", credits: 2 }, { label: "Images", credits: 5 }, { label: "Demo videos", credits: 30 },
  ]);
  assert.deepEqual(result.standalone.map(({ label, credits }) => ({ label, credits })), [
    { label: "UGC videos", credits: 40 }, { label: "Workflow creation", credits: 3 },
  ]);
  assert.equal(result.workflows.reduce((sum, workflow) => sum + workflow.credits, 0) +
    result.standalone.reduce((sum, charge) => sum + charge.credits, 0), result.total);
});

test("deleted automation step charges remain linked through the durable run charge", () => {
  const rows = [
    { reason: "workflow_run", delta: -2, ref: "deleted-workflow", idem_key: "workflow_run:deleted-run" },
    { reason: "image_generation", delta: -5, idem_key: "wf:deleted-run:image" },
  ];
  const runWorkflowIds = new Map<string, string>();
  for (const row of rows) {
    const parts = row.idem_key?.split(":");
    if (row.reason === "workflow_run" && row.ref && parts?.[0] === "workflow_run" && parts[1]) {
      runWorkflowIds.set(parts[1], row.ref);
    }
  }
  const result = summarizeDetailedSpend(rows, "Last 30 days", new Map(), runWorkflowIds);
  assert.deepEqual(result.workflows.map(({ name, credits }) => ({ name, credits })), [
    { name: "Deleted automation", credits: 7 },
  ]);
  assert.deepEqual(result.standalone, []);
});
