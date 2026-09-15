import { NextResponse } from "next/server";

import { resolveRequestContext } from "@/lib/workspace";
import { jsonBody } from "@/lib/request";
import { analyzeWebsite } from "@/lib/ai/analyze";
import { assertPublicUrl } from "@/lib/net/public-url";
import { normalizeWebsite, type BrandProfile, type WebsiteAnalysis } from "@/lib/brand";

/**
 * Onboarding is not a worker: the person is sitting on step 3 waiting for this,
 * so it gets a tighter budget than the video pipeline's 45s.
 */
const TIMEOUT_MS = 25_000;

/**
 * One scrape per workspace at a time.
 *
 * The Firecrawl key is server-owned and shared by every workspace, and each run
 * also spends an OpenAI call, so a field that re-fires on every blur is a real
 * cost. Per-instance only under serverless, which is fine — it is a brake on
 * the common case (one impatient user), not a security boundary.
 */
const inFlight = new Set<string>();

function withDeadline(url: string): Promise<WebsiteAnalysis | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), TIMEOUT_MS);
  });
  // Losing the race does not cancel the loser, so the timer is always cleared —
  // a stray 25s handle is how a lambda is kept alive doing nothing.
  return Promise.race([analyzeWebsite(url).catch(() => null), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Reads the homepage once and files what it finds under `analysis`.
 *
 * Deliberately never writes top-level `description`, `tone`, or `audience`.
 * Those are where a user's own answer lives, and keeping the scrape out of them
 * is what lets the settings page say "from your website — edit if wrong"
 * without storing a provenance flag alongside every field.
 *
 * Failure is silent by design. Returning a guess assembled from the domain name
 * would put words in the user's mouth that they never sanity-checked, and those
 * words then ground every AI step in the workspace.
 */
export async function POST(req: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.supabase || !ctx.userId || !ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const raw = await jsonBody<{ website?: unknown }>(req);
  const website = normalizeWebsite(typeof raw?.website === "string" ? raw.website : "");
  if (!website) {
    return NextResponse.json({ error: "That does not look like a website address." }, { status: 400 });
  }
  // analyzeWebsite guards this too; checking here turns an SSRF probe into a
  // 400 instead of a silent null the client would read as "nothing found".
  if (!(await assertPublicUrl(website))) {
    return NextResponse.json({ error: "That address could not be reached." }, { status: 400 });
  }

  const current = await ctx.supabase
    .from("workspaces")
    .select("brand_profile")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  if (current.error) return NextResponse.json({ error: "Could not read your workspace." }, { status: 500 });
  const profile = (current.data?.brand_profile as BrandProfile | null) ?? {};

  // Already read this exact site: hand back what we have rather than paying for
  // it again because the field was focused and blurred a second time.
  if (profile.website === website && profile.analysis?.description) {
    return NextResponse.json({ analysis: profile.analysis, website, cached: true });
  }

  if (inFlight.has(ctx.workspaceId)) {
    return NextResponse.json({ error: "Still reading your site." }, { status: 429 });
  }
  inFlight.add(ctx.workspaceId);

  let analysis: WebsiteAnalysis | null;
  try {
    analysis = await withDeadline(website);
  } finally {
    inFlight.delete(ctx.workspaceId);
  }

  // Re-read rather than merging onto the copy fetched before the scrape. That
  // copy is up to 25 seconds stale, and the user has been answering questions
  // the whole time — merging onto it would roll their step 2 and step 3 answers
  // back. This narrows the window to the round-trip below.
  const latest = await ctx.supabase
    .from("workspaces")
    .select("brand_profile")
    .eq("id", ctx.workspaceId)
    .maybeSingle();
  const base = (latest.data?.brand_profile as BrandProfile | null) ?? profile;

  const next: BrandProfile = { ...base, website };
  // A failed read still records the URL the user typed — that is their answer,
  // and losing it would make them type it again on the way back.
  if (analysis) next.analysis = { ...base.analysis, ...analysis };

  const saved = await ctx.supabase
    .from("workspaces")
    .update({ brand_profile: next })
    .eq("id", ctx.workspaceId)
    .select("id")
    .maybeSingle();
  if (saved.error || !saved.data) {
    return NextResponse.json({ error: "Could not save what we found." }, { status: 500 });
  }

  return NextResponse.json({ analysis, website, cached: false });
}
