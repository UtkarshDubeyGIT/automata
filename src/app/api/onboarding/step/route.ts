import { NextResponse } from "next/server";

import { resolveRequestContext } from "@/lib/workspace";
import { jsonBody, optionalText, oneOf, count } from "@/lib/request";
import { normalizeWebsite, type BrandProfile } from "@/lib/brand";

const PERSONAS = ["founder", "freelancer", "marketer", "developer", "creator", "professional", "student"] as const;
const AUDIENCE_MODES = ["solo", "team"] as const;

/** Mirrors the caps in /api/settings so a value captured here stays editable there. */
const LIMITS = { description: 5000, tone: 200, audience: 1000 } as const;
const NAME_MAX = 120;

interface StepValues {
  name?: unknown;
  website?: unknown;
  persona?: unknown;
  audienceMode?: unknown;
  description?: unknown;
  tone?: unknown;
  audience?: unknown;
}

/**
 * Persists one step of the first-run flow.
 *
 * Saving per step rather than at the end is what makes an abandoned run
 * resumable: someone who closes the tab on step 4 comes back to step 4 with
 * steps 1-3 still filled, instead of an empty form.
 *
 * Writes top-level fields only. The scrape owns `analysis.*`, and keeping the
 * two apart is what lets `/api/settings` tell "the user told us this" from
 * "we read this off their homepage" without storing a separate provenance flag.
 */
export async function PATCH(req: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const body = await jsonBody<{ step?: unknown; values?: StepValues }>(req);
  const step = count(body?.step, 0, 20);
  if (step === undefined) return NextResponse.json({ error: "Missing step." }, { status: 400 });
  const values = body?.values ?? {};

  const name = optionalText(values.name, NAME_MAX);
  const description = optionalText(values.description, LIMITS.description);
  const tone = optionalText(values.tone, LIMITS.tone);
  const audience = optionalText(values.audience, LIMITS.audience);
  const persona = oneOf(values.persona, PERSONAS);
  const audienceMode = oneOf(values.audienceMode, AUDIENCE_MODES);

  // "" clears the field; a non-empty value that will not parse is a typo worth
  // surfacing rather than silently dropping.
  let website: string | undefined;
  if (typeof values.website === "string") {
    const raw = values.website.trim();
    if (!raw) website = "";
    else {
      website = normalizeWebsite(raw);
      if (!website) {
        return NextResponse.json({ error: "That does not look like a website address." }, { status: 400 });
      }
    }
  }

  const current = await ctx.supabase
    .from("workspaces")
    .select("brand_profile")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  if (current.error) {
    return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500 });
  }

  const profile = (current.data?.brand_profile as BrandProfile | null) ?? {};
  const next: BrandProfile = { ...profile };
  if (website !== undefined) next.website = website;
  if (description !== undefined) next.description = description;
  if (tone !== undefined) next.tone = tone;
  if (audience !== undefined) next.audience = audience;
  if (persona !== undefined) next.persona = persona;
  if (audienceMode !== undefined) next.audienceMode = audienceMode;
  next.onboarding = {
    ...profile.onboarding,
    // Server-side max, not the client's number: the furthest step reached is
    // what a resume depends on, and going back to edit step 2 must not discard
    // the fact that step 5 was already answered.
    step: Math.max(profile.onboarding?.step ?? 0, step),
  };

  const saved = await ctx.supabase
    .from("workspaces")
    .update({ brand_profile: next })
    .eq("id", ctx.workspaceId)
    .select("id")
    .maybeSingle();
  if (saved.error) return NextResponse.json({ error: "Could not save. Please try again." }, { status: 500 });
  if (!saved.data) {
    return NextResponse.json({ error: "You do not have access to this workspace." }, { status: 403 });
  }

  // The signed-in person, not the workspace: `profiles` is where the avatar and
  // display name live, and it is keyed by user rather than workspace.
  if (name) {
    const profileSaved = await ctx.supabase.from("profiles").update({ full_name: name }).eq("id", ctx.userId).select("id").maybeSingle();
    if (profileSaved.error) {
      return NextResponse.json({ error: "Your answers were saved, but your name could not be updated." }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, website: next.website });
}
