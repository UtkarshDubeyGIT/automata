import assert from "node:assert/strict";
import test from "node:test";

import * as plans from "@/lib/billing/plans";
const { PLANS, canActivateWorkflow, isPlanId, normalizePlanId } = plans;

test("billing renders Automata pricing and recognizes an existing Zidane plan", () => {
  const lookup = (plans as unknown as { planById?: (id: string) => { credits: number; priceMonthly: number } | undefined }).planById;
  assert.equal(typeof lookup, "function");
  assert.equal(lookup?.("pro")?.credits, 10_000);
  assert.equal(lookup?.("pro")?.priceMonthly, 19);
  assert.equal(lookup?.("growth")?.credits, 3_000);
  assert.equal(lookup?.("missing"), undefined);
});

test("only Free and Pro are available, while retired Team records resolve to Pro", () => {
  assert.deepEqual(Object.keys(PLANS), ["free", "pro"]);
  assert.equal(isPlanId("team"), false);
  assert.equal(normalizePlanId("team"), "pro");
  const lookup = (plans as unknown as { planById?: (id: string) => { id: string; credits: number } | undefined }).planById;
  assert.equal(lookup?.("team")?.id, "pro");
  assert.equal(lookup?.("team")?.credits, 10_000);
});

test("launch plans expose the agreed monthly credits and retention", () => {
  assert.equal(PLANS.free.monthlyCredits, 1_000);
  assert.equal(PLANS.free.retentionDays, 7);
  assert.equal(PLANS.pro.monthlyCredits, 10_000);
  assert.equal(PLANS.pro.retentionDays, 30);
});

test("pricing features do not advertise workspace members", () => {
  const lookup = (plans as unknown as { BILLING_PLANS?: Array<{ features: string[] }> }).BILLING_PLANS;
  assert.ok(lookup);
  assert.equal(lookup?.some((plan) => plan.features.some((feature) => /members?/i.test(feature))), false);
});

test("free workspaces cannot activate a third workflow", () => {
  assert.equal(canActivateWorkflow("free", 1), true);
  assert.equal(canActivateWorkflow("free", 2), false);
  assert.equal(canActivateWorkflow("pro", 200), true);
});
