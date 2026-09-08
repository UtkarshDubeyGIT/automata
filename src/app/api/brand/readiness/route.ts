import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { brandReadiness, type BrandProfile } from "@/lib/brand";

export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in" }, { status: 401 });
  }
  const { data, error } = await ctx.supabase.from("workspaces")
    .select("brand_profile").eq("id", ctx.workspaceId).maybeSingle();
  if (error || !data) {
    // An unavailable read must not accuse a workspace of having no details.
    return NextResponse.json({ readiness: { ...brandReadiness(null), knowsProduct: true }, unknown: true });
  }
  return NextResponse.json({ readiness: brandReadiness(data.brand_profile as BrandProfile | null) });
}
