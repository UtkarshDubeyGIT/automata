import { NextResponse } from "next/server";

import { resolveRequestContext } from "@/lib/workspace";
import { jsonBody, flag, count } from "@/lib/request";
import type { BrandProfile } from "@/lib/brand";

/**
 * Ends the first-run flow, whether it was finished or skipped.
 *
 * Kept separate from /api/onboarding/step because it writes a different column
 * with different semantics: `step` accumulates answers, this flips the gate.
 *
 * A skip writes NO brand fields — not even defaults. Every line in
 * `brandContext()` is behind an `if`, so an absent field is already omitted
 * from prompts, and `brandKnowsProduct()` already returns false, so the
 * existing BrandGap banners already prompt the user to fill it in. Writing a
 * plausible default instead would hand the AI a voice the user never chose,
 * indistinguishable in storage from one they did.
 */
export async function POST(req: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const body = await jsonBody<{ skipped?: unknown; step?: unknown }>(req);
  const skipped = flag(body?.skipped) ?? false;
  const step = count(body?.step, 0, 20) ?? 0;

  const current = await ctx.supabase
    .from("workspaces")
    .select("brand_profile")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  if (current.error) {
    return NextResponse.json({ error: "Could not finish setup. Please try again." }, { status: 500 });
  }

  const profile = (current.data?.brand_profile as BrandProfile | null) ?? {};
  const next: BrandProfile = {
    ...profile,
    onboarding: {
      ...profile.onboarding,
      step: Math.max(profile.onboarding?.step ?? 0, step),
      completedAt: new Date().toISOString(),
      skipped,
    },
  };

  // Selecting the affected row distinguishes an RLS refusal from a no-op.
  const saved = await ctx.supabase
    .from("workspaces")
    .update({ onboarded: true, brand_profile: next })
    .eq("id", ctx.workspaceId)
    .select("id")
    .maybeSingle();
  if (saved.error) return NextResponse.json({ error: "Could not finish setup." }, { status: 500 });
  if (!saved.data) {
    return NextResponse.json({ error: "You do not have access to this workspace." }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
