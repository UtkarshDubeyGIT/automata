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

export interface BrandProfile {
  company?: string;
  website?: string;
  productType?: string;
  language?: string;
  analysis?: WebsiteAnalysis;
  brandKit?: BrandKit;
  ads?: { metaAdAccountId?: string };
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
  return (r?.targetAudience || profile.analysis?.targetAudience || "").trim();
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
    summary: r?.summary || a.description || "",
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
): string {
  if (!profile) return "";
  const lines: string[] = [];
  if (profile.company) {
    lines.push(`Company: ${profile.company}`);
  }
  if (profile.website) {
    lines.push(`Website: ${profile.website}`);
  }
  if (profile.analysis?.description) {
    lines.push(`Description: ${profile.analysis.description}`);
  }
  if (profile.analysis?.valueProps?.length) {
    lines.push(`Key Value Props: ${profile.analysis.valueProps.join(", ")}`);
  }
  if (profile.analysis?.targetAudience) {
    lines.push(`Target Audience: ${profile.analysis.targetAudience}`);
  }
  return lines.length ? `\n[Brand Context]\n${lines.join("\n")}\n` : "";
}

export function brandVideoHint(profile: BrandProfile | null): string {
  if (!profile) return "";
  const parts: string[] = [];
  if (profile.company) parts.push(`Company: ${profile.company}`);
  if (profile.website) parts.push(`Website: ${profile.website}`);
  return parts.length ? ` ${parts.join(" ")}.` : "";
}
