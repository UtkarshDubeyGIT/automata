import { NextResponse } from "next/server";
import { resolveRequestContext, type RequestContext } from "@/lib/workspace";
import { jsonBody, oneOf } from "@/lib/request";
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

const PERSONAS = ["founder", "freelancer", "marketer", "developer", "creator", "professional", "student"] as const;
const AUDIENCE_MODES = ["solo", "team"] as const;

/**
 * Which tier answered for a field, computed rather than stored.
 *
 * A stored provenance flag has to be maintained by every writer — this route,
 * both onboarding routes, saveBrandKit, the video capture step — and the first
 * one that forgets marks a real user answer as a guess, which silently drops it
 * from every AI prompt in the app. Deriving it cannot drift.
 */
function sourceOf(own: string | undefined, site: string | undefined): "user" | "site" | "none" {
  if (own) return "user";
  if (site) return "site";
  return "none";
}
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
  const [{ data, error }, identity, account] = await Promise.all([
    readWorkspace(ctx),
    ctx.supabase.auth.getUser(),
    // The signed-in person, not the workspace. `brand_profile.company` names
    // the business, so the avatar beside "Signed in as" has to come from
    // `profiles`, which every Google login refreshes with the name and photo.
    ctx.supabase.from("profiles").select("full_name, avatar_url").eq("id", ctx.userId).maybeSingle(),
  ]);
  if (error) return NextResponse.json({ error: "Could not load your settings. Please try again." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const ws = data as Workspace;
  const profile = ws.brand_profile;
  return NextResponse.json({
    email: identity.data.user?.email ?? null,
    name: account.data?.full_name ?? null,
    avatarUrl: account.data?.avatar_url ?? null,
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
      persona: profile?.persona ?? "",
      audienceMode: profile?.audienceMode ?? "",
    },
    sources: {
      description: sourceOf(profile?.description, profile?.analysis?.description),
      tone: sourceOf(profile?.tone, profile?.analysis?.voice),
      audience: sourceOf(profile?.audience, profile?.analysis?.targetAudience),
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
  const hasEnum = body.persona !== undefined || body.audienceMode !== undefined;
  if (!Object.keys(patch).length && !hasEnum) {
    return NextResponse.json({ error: "No settings to save." }, { status: 400 });
  }
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

  const persona = body.persona === undefined ? undefined : oneOf(body.persona, PERSONAS);
  if (body.persona !== undefined && persona === undefined) {
    return NextResponse.json({ error: "Check the persona field." }, { status: 400 });
  }
  const audienceMode = body.audienceMode === undefined ? undefined : oneOf(body.audienceMode, AUDIENCE_MODES);
  if (body.audienceMode !== undefined && audienceMode === undefined) {
    return NextResponse.json({ error: "Check the audienceMode field." }, { status: 400 });
  }

  const { data, error: readError, legacy } = await readWorkspace(ctx);
  if (readError) return NextResponse.json({ error: "Could not load your settings. Nothing was changed." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Workspace not found." }, { status: 404 });
  const current = (data as Workspace).brand_profile ?? {};
  const next: BrandProfile = { ...current };
  for (const key of ["company", "website", "description", "tone", "audience", "voiceGuidelines", "language"] as const) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  // Deliberately NOT mirrored into `analysis`. Every reader already prefers the
  // top-level value (`profile.tone || profile.analysis?.voice`, and the same
  // shape in brandReadiness and statedAudience), so copying it down bought
  // nothing — and it destroyed the one distinction that matters here, between
  // what the user told us and what we read off their homepage. Keeping the two
  // apart is what lets this route report an honest `sources` map below.
  if (persona !== undefined) next.persona = persona;
  if (audienceMode !== undefined) next.audienceMode = audienceMode;
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
