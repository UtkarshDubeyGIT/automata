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
  for (const plan of ["pro"] as const) {
    if (priceId === stripePrice(plan, false) || priceId === stripePrice(plan, true)) return plan;
  }
  // Existing Stripe subscriptions can still carry the retired Team price.
  // They receive the Pro allowance until they are moved to the Pro price.
  if (priceId === process.env.STRIPE_PRICE_TEAM_MONTHLY || priceId === process.env.STRIPE_PRICE_TEAM_ANNUAL) return "pro";
  return null;
}
