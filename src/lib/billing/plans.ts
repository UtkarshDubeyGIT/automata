export type PlanId = "free" | "pro";

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  monthlyCredits: number;
  activeWorkflowLimit: number | null;
  retentionDays: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    monthlyCredits: 1_000,
    activeWorkflowLimit: 2,
    retentionDays: 7,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 19,
    monthlyCredits: 10_000,
    activeWorkflowLimit: null,
    retentionDays: 30,
  },
};

export function canActivateWorkflow(planId: PlanId, activeCount: number): boolean {
  const limit = PLANS[planId].activeWorkflowLimit;
  return limit === null || activeCount < limit;
}

/**
 * True only for a currently supported `workspaces.plan` value (free/pro).
 *
 * `planById` also matches legacy Zidane labels (starter/growth/scale) for
 * display, but those are not valid values for the `plan_id` Postgres enum —
 * writing one there throws 22P02. Callers that write to `workspaces.plan`
 * must check this first rather than trust `planById`'s wider match.
 */
export function isPlanId(id: string): id is PlanId {
  return Object.prototype.hasOwnProperty.call(PLANS, id);
}

/**
 * Team was retired in favor of Pro. Keep old workspace and Stripe records on
 * Pro until the database migration reaches them, without making Team a plan
 * that UI or checkout can offer again.
 */
export function normalizePlanId(id: string | null | undefined): PlanId {
  return id === "team" || id === "pro" ? "pro" : "free";
}

export interface BillingPlan {
  id: string;
  name: string;
  priceMonthly: number;
  credits: number;
  features: string[];
  highlighted?: boolean;
}

/** Zidane's billing components consume this view of Automata's price book. */
export const BILLING_PLANS: BillingPlan[] = Object.values(PLANS).map((plan) => ({
  id: plan.id,
  name: plan.name,
  priceMonthly: plan.monthlyPrice,
  credits: plan.monthlyCredits,
  highlighted: plan.id === "pro",
  features: [
    `${plan.monthlyCredits.toLocaleString("en-US")} ${plan.monthlyPrice === 0 ? "credits to start" : "credits / month"}`,
    plan.activeWorkflowLimit === null ? "Unlimited active workflows" : `${plan.activeWorkflowLimit} active workflows`,
    `${plan.retentionDays} days of run history`,
  ],
}));

/** Existing Zidane workspaces keep their recorded subscription when opened here. */
const LEGACY_PLANS: BillingPlan[] = [
  { id: "starter", name: "Starter", priceMonthly: 29, credits: 1000, features: [] },
  { id: "growth", name: "Growth Plan", priceMonthly: 99, credits: 3000, features: [] },
  { id: "scale", name: "Scale", priceMonthly: 299, credits: 12000, features: [] },
];

export function planById(id: string): BillingPlan | undefined {
  if (id === "team") return BILLING_PLANS.find((plan) => plan.id === "pro");
  return BILLING_PLANS.find((plan) => plan.id === id) ?? LEGACY_PLANS.find((plan) => plan.id === id);
}
