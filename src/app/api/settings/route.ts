import { NextResponse } from "next/server";
import { resolveRequestContext, type RequestContext } from "@/lib/workspace";
import { jsonBody } from "@/lib/request";
import type { BrandProfile } from "@/lib/brand";

const FIELDS = {
  company: 80,
  website: 2000,
  description: 5000,
  tone: 200,
  audience: 1000,
  voiceGuidelines: 4000,
  language: 80,
  metaAdAccountId: 64,
  googleAdsCustomerId: 32,
  ga4PropertyId: 32,
  linkedinOrganizationId: 64,
  timezone: 100,
} as const;
type Field = keyof typeof FIELDS;
type Workspace = { id: string; name: string; timezone?: string; brand_profile: BrandProfile | null };
type DatabaseError = { code?: string; message?: string } | null;

function missingTimezone(error: DatabaseError) {
  return !!error && ["42703", "PGRST204"].includes(error.code ?? "") && /timezone/i.test(error.message ?? "");
}

/** Source Zidane databases store timezone only on agent_settings. */
async function readWorkspace(ctx: RequestContext) {
  const db = ctx.supabase!;
  const initial = await db.from("workspaces").select("id, name, brand_profile, timezone").eq("id", ctx.workspaceId!).maybeSingle();
  if (!missingTimezone(initial.error)) return { ...initial, legacy: false };
  const result = await db.from("workspaces").select("id, name, brand_profile").eq("id", ctx.workspaceId!).maybeSingle();
  if (result.error || !result.data) return { ...result, legacy: true };
  const zone = await db.from("agent_settings").select("timezone").eq("workspace_id", ctx.workspaceId!).maybeSingle();
  return {
    data: { ...result.data, timezone: zone.data?.timezone ?? "UTC" },
    error: zone.error,
    legacy: true,
  };
}

export async function GET() {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to view your settings." }, { status: 401 });
  }
  const [{ data, error }, identity] = await Promise.all([
    readWorkspace(ctx),
    ctx.supabase.auth.getUser(),
  ]);
  if (error) return NextResponse.json({ error: "Could not load your settings. Please try again." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const ws = data as Workspace;
  const profile = ws.brand_profile;
  return NextResponse.json({
    email: identity.data.user?.email ?? null,
    settings: {
      company: profile?.company || ws.name,
      website: profile?.website ?? "",
      description: profile?.description ?? profile?.analysis?.description ?? "",
      tone: profile?.tone ?? profile?.analysis?.voice ?? "",
      audience: profile?.audience ?? profile?.analysis?.targetAudience ?? "",
      voiceGuidelines: profile?.voiceGuidelines ?? "",
      language: profile?.language || profile?.analysis?.language || "English",
      metaAdAccountId: profile?.ads?.metaAdAccountId ?? "",
      googleAdsCustomerId: profile?.ads?.googleAdsCustomerId ?? "",
      ga4PropertyId: profile?.analytics?.ga4PropertyId ?? "",
      linkedinOrganizationId: profile?.analytics?.linkedinOrganizationId ?? "",
      timezone: ws.timezone || "UTC",
    },
  });
}

export async function PATCH(req: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to change your settings." }, { status: 401 });
  }
  const body = await jsonBody<Record<string, unknown>>(req);
  if (!body) return NextResponse.json({ error: "Send a settings object." }, { status: 400 });
  const patch: Partial<Record<Field, string>> = {};
  for (const [key, max] of Object.entries(FIELDS) as [Field, number][]) {
    if (!(key in body)) continue;
    const value = body[key];
    if (typeof value !== "string" || value.trim().length > max) {
      return NextResponse.json({ error: `Check the ${key} field.` }, { status: 400 });
    }
    patch[key] = value.trim();
  }
  if (!Object.keys(patch).length) return NextResponse.json({ error: "No settings to save." }, { status: 400 });
  if (patch.company === "") return NextResponse.json({ error: "Enter a workspace name." }, { status: 400 });
  if (patch.website) {
    try {
      if (!["https:", "http:"].includes(new URL(patch.website).protocol)) throw new Error("protocol");
    } catch {
      return NextResponse.json({ error: "Enter a website starting with https:// or http://." }, { status: 400 });
    }
  }
  if (patch.timezone !== undefined) {
    try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }).format(); }
    catch { return NextResponse.json({ error: "Choose a valid time zone." }, { status: 400 }); }
  }

  const { data, error: readError, legacy } = await readWorkspace(ctx);
  if (readError) return NextResponse.json({ error: "Could not load your settings. Nothing was changed." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const current = (data as Workspace).brand_profile ?? {};
  const next: BrandProfile = { ...current };
  for (const key of ["company", "website", "description", "tone", "audience", "voiceGuidelines", "language"] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (patch.description !== undefined) next.analysis = { ...next.analysis, description: patch.description };
  if (patch.audience !== undefined) next.analysis = { ...next.analysis, targetAudience: patch.audience };
  if (patch.tone !== undefined) next.analysis = { ...next.analysis, voice: patch.tone };
  for (const key of ["metaAdAccountId", "googleAdsCustomerId"] as const) {
    if (patch[key] !== undefined) next.ads = { ...next.ads, [key]: patch[key] };
  }
  for (const key of ["ga4PropertyId", "linkedinOrganizationId"] as const) {
    if (patch[key] !== undefined) next.analytics = { ...next.analytics, [key]: patch[key] };
  }
  const update = {
    brand_profile: next,
    ...(patch.company !== undefined ? { name: patch.company } : {}),
    ...(!legacy && patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
  };
  // The standalone schema synchronizes agent_settings in this transaction.
  // Selecting the affected row distinguishes an RLS refusal from success.
  const saved = await ctx.supabase.from("workspaces").update(update).eq("id", ctx.workspaceId).select("id").maybeSingle();
  if (saved.error) return NextResponse.json({ error: "Could not save your settings." }, { status: 500 });
  if (!saved.data) return NextResponse.json({ error: "Only workspace admins can change these settings." }, { status: 403 });
  if (legacy && patch.timezone !== undefined) {
    const zone = await ctx.supabase.from("agent_settings").update({ timezone: patch.timezone }).eq("workspace_id", ctx.workspaceId).select("workspace_id").maybeSingle();
    if (zone.error || !zone.data) {
      return NextResponse.json({ error: "Your profile was saved, but the time zone could not be updated. Please try again." }, { status: 500 });
    }
  }
  return NextResponse.json({ ok: true });
}
