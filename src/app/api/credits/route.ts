import { NextResponse } from "next/server";
import { getBalance, priceBook } from "@/lib/credits";
import { resolveRequestContext, getWorkspaceContext } from "@/lib/workspace";
import { supabaseConfigured } from "@/lib/env";
import { normalizePlanId } from "@/lib/billing/plans";

/**
 * Balance and the price book, together with the active plan.
 *
 * Together on purpose: a screen that shows "Generate · 3 credits" needs both
 * the price and whether the user can afford it, and fetching those from two
 * places is how they end up disagreeing. Returning the workspace plan alongside
 * the live balance ensures the app shell and billing meter stay synchronized.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  if (!supabaseConfigured) {
    const context = await getWorkspaceContext();
    return NextResponse.json({ credits: context.credits, plan: normalizePlanId(context.plan), prices: priceBook(), demo: true });
  }
  const rc = await resolveRequestContext();
  let credits = 0;
  let plan = "free";

  if (rc.workspaceId) {
    credits = await getBalance(rc.workspaceId);
    if (rc.supabase) {
      const { data: ws } = await rc.supabase
        .from("workspaces")
        .select("plan")
        .eq("id", rc.workspaceId)
        .maybeSingle();
      if (ws?.plan) plan = ws.plan;
    }
  }

  return NextResponse.json({ credits, plan: normalizePlanId(plan), prices: priceBook(), demo: false });
}
