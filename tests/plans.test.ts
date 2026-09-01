import assert from "node:assert/strict";
import test from "node:test";

import { PLANS, canActivateWorkflow } from "@/lib/billing/plans";

test("launch plans expose the agreed monthly credits and retention", () => {
  assert.equal(PLANS.free.monthlyCredits, 1_000);
  assert.equal(PLANS.free.retentionDays, 7);
  assert.equal(PLANS.pro.monthlyCredits, 10_000);
  assert.equal(PLANS.pro.retentionDays, 30);
  assert.equal(PLANS.team.monthlyCredits, 40_000);
  assert.equal(PLANS.team.retentionDays, 90);
});

test("free workspaces cannot activate a third workflow", () => {
  assert.equal(canActivateWorkflow("free", 1), true);
  assert.equal(canActivateWorkflow("free", 2), false);
  assert.equal(canActivateWorkflow("pro", 200), true);
});
