import "server-only";

import Stripe from "stripe";

import type { PlanId } from "./plans";

export function stripeClient(): Stripe | null {
  return process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
}

export function stripePrice(plan: Exclude<PlanId, "free">, annual: boolean): string | null {
  const key = `STRIPE_PRICE_${plan.toUpperCase()}_${annual ? "ANNUAL" : "MONTHLY"}`;
  return process.env[key] ?? null;
}

export function planForPrice(priceId: string | null | undefined): PlanId | null {
  if (!priceId) return null;
  for (const plan of ["pro", "team"] as const) {
    if (priceId === stripePrice(plan, false) || priceId === stripePrice(plan, true)) return plan;
  }
  return null;
}
