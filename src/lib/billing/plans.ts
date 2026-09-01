export type PlanId = "free" | "pro" | "team";

export interface Plan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  monthlyCredits: number;
  activeWorkflowLimit: number | null;
  memberLimit: number;
  retentionDays: number;
}

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free",
    monthlyPrice: 0,
    monthlyCredits: 1_000,
    activeWorkflowLimit: 2,
    memberLimit: 1,
    retentionDays: 7,
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 19,
    monthlyCredits: 10_000,
    activeWorkflowLimit: null,
    memberLimit: 3,
    retentionDays: 30,
  },
  team: {
    id: "team",
    name: "Team",
    monthlyPrice: 59,
    monthlyCredits: 40_000,
    activeWorkflowLimit: null,
    memberLimit: 10,
    retentionDays: 90,
  },
};

export function canActivateWorkflow(planId: PlanId, activeCount: number): boolean {
  const limit = PLANS[planId].activeWorkflowLimit;
  return limit === null || activeCount < limit;
}
