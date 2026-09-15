import { createAdminClient } from "@/lib/supabase/server";
import { supabaseConfigured } from "@/lib/env";

export interface WebsiteAnalysis {
  description?: string;
  language?: string;
  productType?: string;
  valueProps?: string[];
  features?: string[];
  voice?: string;
  targetAudience?: string;
  brandColors?: string[];
  keywords?: string[];
  pricingModel?: string;
  socialProof?: string;
}

export interface BrandKit {
  logoUrl?: string;
  logoOverlayUrl?: string;
  logoSource?: "user" | "scan";
  colors?: string[];
  primaryColor?: string;
  accentColor?: string;
  backgroundColor?: string;
  textColor?: string;
  headingFont?: string;
  bodyFont?: string;
  headingFontUrl?: string;
  bodyFontUrl?: string;
  fontSource?: "site" | "google";
  fontSizes?: string[];
  themeColor?: string;
  capturedFrom?: string;
  capturedAt?: string;
}

/** Who the person setting up the workspace is. Captured in the first-run flow. */
export type Persona =
  | "founder"
  | "freelancer"
  | "marketer"
  | "developer"
  | "creator"
  | "professional"
  | "student";

export interface OnboardingState {
  /** Furthest step reached, so an abandoned run resumes where it stopped. */
  step?: number;
  completedAt?: string;
  skipped?: boolean;
}

export interface BrandProfile {
  company?: string;
  website?: string;
  /** Explicit workspace description, ahead of earlier website research. */
  description?: string;
  tone?: string;
  cta?: string;
  audience?: string;
  voiceGuidelines?: string;
  productType?: string;
  language?: string;
  /**
   * Stored for segmentation and future template matching; deliberately NOT
   * rendered into prompts. Telling a model "the user is a Student" changes its
   * writing in ways nobody has specified.
   */
  persona?: Persona;
  /**
   * Whether the workspace speaks as a person or an organization. Unlike
   * `persona`, this DOES reach the prompt — it picks first-person singular or
   * plural, which is visible in every generated sentence.
   */
  audienceMode?: "solo" | "team";
  onboarding?: OnboardingState;
  analysis?: WebsiteAnalysis;
  brandKit?: BrandKit;
  ads?: { metaAdAccountId?: string; googleAdsCustomerId?: string };
  analytics?: { ga4PropertyId?: string; linkedinOrganizationId?: string };
  assets?: { url: string; name?: string; type?: string }[];
  research?: {
    status?: "ready" | "pending" | "failed" | "none";
    summary?: string;
    valueProps?: string[];
    capabilities?: string[];
    targetAudience?: string;
    category?: string;
  };
}

export interface BrandReadiness {
  knowsProduct: boolean;
  company: string;
  website: string;
  summary: string;
  valueProps: string[];
  features: string[];
  audience: string;
  hasAssets: boolean;
  hasBrandKit: boolean;
  researchStatus?: string;
}

export function statedAudience(profile: BrandProfile | null): string {
  if (!profile) return "";
  const r = profile.research?.status === "ready" ? profile.research : null;
  return (profile.audience || r?.targetAudience || profile.analysis?.targetAudience || "").trim();
}

export function brandKnowsProduct(
  profile: BrandProfile | null,
  opts?: { includeResearch?: boolean },
): boolean {
  if (!profile) return false;
  const a = profile.analysis ?? {};
  const r =
    opts?.includeResearch === false
      ? null
      : profile.research?.status === "ready"
        ? profile.research
        : null;
  const valueProps = r?.valueProps?.length ? r.valueProps : a.valueProps;
  const features = r?.capabilities?.length ? r.capabilities : a.features;
  return !!(
    profile.description ||
    r?.summary ||
    a.description ||
    valueProps?.length ||
    features?.length ||
    statedAudience(profile)
  );
}

export function brandReadiness(profile: BrandProfile | null): BrandReadiness {
  const a = profile?.analysis ?? {};
  const r = profile?.research?.status === "ready" ? profile.research : null;
  const kit = profile?.brandKit;
  return {
    knowsProduct: brandKnowsProduct(profile),
    company: profile?.company ?? "",
    website: profile?.website ?? "",
    summary: profile?.description || r?.summary || a.description || "",
    valueProps: (r?.valueProps?.length ? r.valueProps : a.valueProps) ?? [],
    features: (r?.capabilities?.length ? r.capabilities : a.features) ?? [],
    audience: statedAudience(profile),
    hasAssets: !!profile?.assets?.length,
    hasBrandKit: !!(kit?.colors?.length || kit?.logoUrl || kit?.primaryColor),
    researchStatus: profile?.research?.status ?? "none",
  };
}

export async function getBrandProfileForWorkspace(
  workspaceId: string,
): Promise<BrandProfile | null> {
  if (!supabaseConfigured) return null;
  const db = createAdminClient();
  if (!db) return null;
  const { data, error } = await db
    .from("workspaces")
    .select("brand_profile")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error) {
    return null;
  }
  return (data?.brand_profile as BrandProfile) ?? null;
}

export function brandContext(
  profile: BrandProfile | null,
  opts?: { includeResearch?: boolean },
): string {
  if (!profile) return "";
  const lines: string[] = [];
  if (profile.company) {
    lines.push(`Company: ${profile.company}`);
  }
  if (profile.website) {
    lines.push(`Website: ${profile.website}`);
  }
  const details = brandReadiness(opts?.includeResearch === false ? { ...profile, research: undefined } : profile);
  if (details.summary) lines.push(`Description: ${details.summary}`);
  if (details.valueProps.length) lines.push(`Key Value Props: ${details.valueProps.join(", ")}`);
  if (details.features.length) lines.push(`Features: ${details.features.join(", ")}`);
  if (details.audience) lines.push(`Target Audience: ${details.audience}`);
  const language = profile.language || profile.analysis?.language;
  if (language) lines.push(`Content Language: ${language}`);
  const voice = profile.tone || profile.analysis?.voice;
  if (voice) lines.push(`Brand Voice: ${voice}`);
  // Whether the workspace speaks as a person or an organization. Without it the
  // model guesses, and a solo freelancer ends up writing "our team is excited
  // to announce" about themselves.
  if (profile.audienceMode === "solo") lines.push("Voice Person: write as one person — I, my, me.");
  if (profile.audienceMode === "team") lines.push("Voice Person: write as a company — we, our, us.");
  if (profile.voiceGuidelines) lines.push(`Voice Guidelines: ${profile.voiceGuidelines}`);
  return lines.length ? `\n[Brand Context]\n${lines.join("\n")}\n` : "";
}

export function brandProductContext(profile: BrandProfile | null): string {
  if (!profile) return "";
  const bits = [profile.company, profile.description || profile.analysis?.description || ""].filter(Boolean);
  return bits.length ? ` Product context: ${bits.join(" — ")}.` : "";
}

/**
 * Compact product hint for VISUAL prompts (video/image generation) — keeps the
 * prompt scene-focused while grounding it in the actual product.
 *
 * Visual-only. Do not append this to a prompt that reaches a text model; use
 * `brandProductContext` for that.
 */
export function brandVideoHint(profile: BrandProfile | null): string {
  if (!profile) return "";

  let hint = brandProductContext(profile);

  // Direct the visual to match the brand identity. Prefer the kit extracted
  // live from the site; fall back to the colors captured during onboarding
  // analysis so images/video stay on-brand even before a demo capture.
  const kit = profile.brandKit;
  const parts: string[] = [];
  const kitColors = kit?.colors?.length ? kit.colors : profile.analysis?.brandColors;
  if (kitColors?.length) parts.push(`use the brand palette ${kitColors.slice(0, 5).join(", ")}`);
  if (kit?.primaryColor) parts.push(`accent color ${kit.primaryColor}`);
  const fonts = [kit?.headingFont, kit?.bodyFont].filter(Boolean);
  if (fonts.length) parts.push(`typography like ${[...new Set(fonts)].join(" / ")}`);
  if (parts.length) {
    hint += ` Match the brand identity — ${parts.join("; ")}, consistent with the product's website.`;
  }

  // A generative video model cannot draw a real logo. Asked to "leave space for
  // the logo" it would invent a wordmark that looked approximately right and
  // was never ours — which is exactly the complaint about ZidaneAI's own mark
  // not matching. So forbid rendered branding outright and reserve a clean
  // corner; the real logo is composited onto the finished clip in
  // postproduce.ts, where it is pixel-exact.
  hint +=
    " Do not render any logo, wordmark, brand name, watermark, subtitles or" +
    " other text anywhere in the frame — no invented or approximated logos." +
    " Keep the lower-right corner visually clean and uncluttered.";

  return hint;
}

export function narrationLanguage(profile?: BrandProfile | null): string {
  const ok = (v: string | undefined) => {
    const t = (v ?? "").trim();
    return t && t.length <= 40 ? t : "";
  };
  // The workspace setting is a decision and outranks everything. The site
  // reading is an observation, and only answers when no decision was made —
  // which is still far better than the old fallback, since defaulting a
  // Spanish-language brand to English is itself an inference, just a worse one.
  return ok(profile?.language) || ok(profile?.analysis?.language) || "English";
}


export async function saveBrandKit(
  workspaceId: string,
  kit: BrandKit,
  /**
   * The site this kit describes, when the caller knows it.
   *
   * Written in the SAME read-modify-write as the kit, and that matters: the
   * palette, logo and fonts all come from one URL, and `website` is what the
   * end card prints and what every agent cites. Saving them separately — or,
   * as before, not saving the website at all — lets a workspace end up with one
   * site's colours and another site's address, which is exactly what shipped:
   * company "atlassian.com", website "dubey.page", and Atlassian's brand
   * colours in the kit.
   */
  opts?: { website?: string },
): Promise<void> {
  if (!supabaseConfigured) return;
  const db = createAdminClient();
  const { data } = await db
    .from("workspaces")
    .select("brand_profile")
    .eq("id", workspaceId)
    .maybeSingle();
  const profile = (data?.brand_profile as BrandProfile) ?? {};

  const next = mergeKit(profile.brandKit, kit);

  const website = (opts?.website ?? "").trim();
  await db
    .from("workspaces")
    .update({
      brand_profile: {
        ...profile,
        brandKit: next,
        ...(website ? { website } : {}),
      },
    })
    .eq("id", workspaceId);
}

/**
 * Fold a freshly-read kit onto the stored one, keeping a logo a PERSON chose.
 *
 * Callers that represent a deliberate choice say so by setting
 * `logoSource: "user"` on the kit they pass, and that always wins; everything
 * else inherits the stored logo rather than overwriting it. Without this the
 * last writer won, so scanning your site — or simply generating a product demo
 * — silently replaced the mark the user had uploaded.
 *
 * Shared by both writers. `saveWebsiteRead` used to assign `brandKit` raw,
 * which was harmless while onboarding was its only caller (nobody has uploaded
 * a logo yet on that path) and stopped being harmless the moment Settings could
 * re-run a site read.
 */
function mergeKit(stored: BrandKit | undefined, incoming: BrandKit): BrandKit {
  const keepUserLogo = stored?.logoSource === "user" && incoming.logoSource !== "user";
  if (!keepUserLogo) return incoming;
  return {
    ...incoming,
    logoUrl: stored.logoUrl,
    logoOverlayUrl: stored.logoOverlayUrl,
    logoSource: "user",
  };
}

/**
 * Normalise a site the user typed into something storable.
 *
 * Deliberately NOT a reachability check — someone may set their site before it
 * is live, and refusing to save that would be worse than storing it. Anything
 * handed to a browser or a fetch still goes through `assertPublicUrl` at the
 * point of use.
 */
export function normalizeWebsite(raw: string | undefined | null): string | undefined {
  const t = (raw ?? "").trim();
  if (!t || t.length > 200) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    if (!u.hostname.includes(".")) return undefined;
    return u.origin + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return undefined;
  }
}
