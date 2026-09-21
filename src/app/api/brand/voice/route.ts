import { NextResponse } from "next/server";
import { jsonBody, oneOf } from "@/lib/request";
import { resolveRequestContext } from "@/lib/workspace";
import { buildVoiceCandidate, sanitizeVoiceSamples, type VoiceSample } from "@/lib/brand-learning";
import type { BrandProfile } from "@/lib/brand";

const ACTIONS = ["accept", "disable", "delete"] as const;

async function contextWithRole() {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) return { ctx, role: null };
  const { data } = await ctx.supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", ctx.workspaceId)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  return { ctx, role: data?.role as string | null };
}

export async function GET() {
  const { ctx, role } = await contextWithRole();
  if (!ctx.supabase || !ctx.workspaceId) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  const admin = role === "owner" || role === "admin";
  let query = ctx.supabase
    .from("workspace_brand_voice_profiles")
    .select("id, version, status, guidance, confidence, source_refs, sample_window_start, sample_window_end, sample_count, approved_at, created_at, updated_at")
    .eq("workspace_id", ctx.workspaceId)
    .order("version", { ascending: false });
  // Members can use the accepted workspace guidance, but must not see draft,
  // disabled, or deleted candidates. Admins need the review queue.
  if (admin) query = query.limit(20);
  else query = query.eq("status", "accepted").limit(1);
  const { data, error } = await query;
  if (error) return NextResponse.json({ error: "Could not load learned brand voice." }, { status: 502 });
  return NextResponse.json({ profiles: data ?? [] });
}

export async function POST(req: Request) {
  const { ctx, role } = await contextWithRole();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Only workspace admins can learn brand voice." }, { status: 403 });
  const body = await jsonBody<{ samples?: unknown; website?: unknown }>(req);
  if (!body) return NextResponse.json({ error: "Send selected samples as JSON." }, { status: 400 });
  const rawSamples = Array.isArray(body.samples) ? body.samples : [];
  const samples: VoiceSample[] = rawSamples.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const sample = value as Record<string, unknown>;
    if (typeof sample.sourceType !== "string" || typeof sample.accountId !== "string" || typeof sample.sourceId !== "string" || typeof sample.authorId !== "string" || typeof sample.createdAt !== "string" || typeof sample.text !== "string") return [];
    return [{
      sourceType: sample.sourceType as VoiceSample["sourceType"],
      accountId: sample.accountId,
      sourceId: sample.sourceId,
      authorId: sample.authorId,
      createdAt: sample.createdAt,
      text: sample.text,
    }];
  });
  if (!samples.length && typeof body.website !== "string") {
    return NextResponse.json({ error: "Select at least one recent Gmail/Slack sample or provide a website." }, { status: 400 });
  }
  if (samples.length > 100) return NextResponse.json({ error: "Select at most 100 samples." }, { status: 400 });

  const connected = await ctx.supabase
    .from("connections")
    .select("app_slug, provider_account_id, status")
    .eq("workspace_id", ctx.workspaceId)
    .in("app_slug", ["gmail", "slack"]);
  if (connected.error) return NextResponse.json({ error: "Could not verify the selected source accounts." }, { status: 502 });
  const available = new Set(
    (connected.data ?? [])
      .filter((row) => row.status === "connected" && row.provider_account_id)
      .map((row) => `${row.app_slug}:${row.provider_account_id}`),
  );
  const unavailable = samples.find((sample) => !sample.accountId || !available.has(`${sample.sourceType}:${sample.accountId}`));
  if (unavailable) {
    return NextResponse.json(
      { error: `Select a connected ${unavailable.sourceType} account owned by this workspace before sampling it.` },
      { status: 409 },
    );
  }

  const sanitized = sanitizeVoiceSamples(samples);
  if (!sanitized.length && !String(body.website ?? "").trim()) {
    return NextResponse.json({ error: "No eligible samples remain after the 90-day and privacy filters." }, { status: 400 });
  }
  const website = String(body.website ?? "").trim().slice(0, 200);
  let websiteGuidance = "";
  if (website) {
    const workspace = await ctx.supabase.from("workspaces").select("brand_profile").eq("id", ctx.workspaceId).maybeSingle();
    const profile = (workspace.data?.brand_profile as BrandProfile | null) ?? null;
    websiteGuidance = String(profile?.analysis?.voice ?? "").trim().slice(0, 500);
  }
  const candidate = buildVoiceCandidate(sanitized, { website, websiteGuidance });
  const latest = await ctx.supabase
    .from("workspace_brand_voice_profiles")
    .select("version")
    .eq("workspace_id", ctx.workspaceId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest.error) return NextResponse.json({ error: "Could not prepare a new voice candidate." }, { status: 502 });
  const version = Number(latest.data?.version ?? 0) + 1;
  const inserted = await ctx.supabase
    .from("workspace_brand_voice_profiles")
    .insert({
      workspace_id: ctx.workspaceId,
      version,
      status: "candidate",
      guidance: candidate.guidance,
      confidence: candidate.confidence,
      source_refs: candidate.sourceRefs,
      sample_window_start: candidate.sampleWindowStart,
      sample_window_end: candidate.sampleWindowEnd,
      sample_count: candidate.sampleCount,
      created_by: ctx.userId,
    })
    .select("id, version, status, guidance, confidence, source_refs, sample_window_start, sample_window_end, sample_count, created_at")
    .maybeSingle();
  if (inserted.error || !inserted.data) return NextResponse.json({ error: "Could not save the voice candidate." }, { status: 502 });
  return NextResponse.json({ profile: inserted.data }, { status: 201 });
}

export async function PATCH(req: Request) {
  const { ctx, role } = await contextWithRole();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) return NextResponse.json({ error: "Sign in" }, { status: 401 });
  if (role !== "owner" && role !== "admin") return NextResponse.json({ error: "Only workspace admins can change learned brand voice." }, { status: 403 });
  const body = await jsonBody<{ id?: unknown; action?: unknown }>(req);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  const action = oneOf(body?.action, ACTIONS);
  if (!id || !action) return NextResponse.json({ error: "Choose a voice profile and action." }, { status: 400 });
  const { data: profile, error: readError } = await ctx.supabase
    .from("workspace_brand_voice_profiles")
    .select("id, version, guidance, status")
    .eq("id", id)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  if (readError || !profile) return NextResponse.json({ error: "Voice profile not found." }, { status: 404 });
  const nextStatus = action === "accept" ? "accepted" : action === "disable" ? "disabled" : "deleted";
  if (action === "accept") {
    await ctx.supabase.from("workspace_brand_voice_profiles").update({ status: "disabled" }).eq("workspace_id", ctx.workspaceId).eq("status", "accepted");
  }
  const updated = await ctx.supabase
    .from("workspace_brand_voice_profiles")
    .update({
      status: nextStatus,
      ...(action === "accept" ? { approved_by: ctx.userId, approved_at: new Date().toISOString() } : {}),
    })
    .eq("id", id)
    .eq("workspace_id", ctx.workspaceId)
    .select("id, version, status, guidance, confidence, source_refs, sample_window_start, sample_window_end, sample_count, approved_at")
    .maybeSingle();
  if (updated.error || !updated.data) return NextResponse.json({ error: "Could not update the voice profile." }, { status: 502 });

  const workspace = await ctx.supabase.from("workspaces").select("brand_profile").eq("id", ctx.workspaceId).maybeSingle();
  if (workspace.data) {
    const current = (workspace.data.brand_profile as BrandProfile | null) ?? {};
    const nextProfile: BrandProfile = { ...current };
    if (action === "accept") {
      nextProfile.learnedVoice = { version: Number(profile.version), guidance: String(profile.guidance), status: "accepted" };
    } else {
      delete nextProfile.learnedVoice;
    }
    await ctx.supabase.from("workspaces").update({ brand_profile: nextProfile }).eq("id", ctx.workspaceId);
  }
  return NextResponse.json({ profile: updated.data });
}
