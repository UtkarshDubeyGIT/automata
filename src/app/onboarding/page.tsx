import { getWorkspaceContext, resolveRequestContext } from "@/lib/workspace";
import type { BrandProfile } from "@/lib/brand";

import { OnboardingFlow } from "./flow";

/**
 * Loads whatever the workspace already knows so a resumed run reopens filled in
 * rather than blank. The gate itself lives in layout.tsx, which has already
 * decided this person belongs here by the time the page renders.
 */
export default async function OnboardingPage() {
  const [ctx, req] = await Promise.all([getWorkspaceContext(), resolveRequestContext()]);

  let profile: BrandProfile = {};
  if (req.supabase && req.workspaceId) {
    const { data } = await req.supabase
      .from("workspaces")
      .select("brand_profile")
      .eq("id", req.workspaceId)
      .maybeSingle();
    profile = (data?.brand_profile as BrandProfile | null) ?? {};
  }

  return (
    <OnboardingFlow
      name={ctx.userName}
      email={ctx.userEmail}
      avatarUrl={ctx.userAvatarUrl}
      profile={profile}
    />
  );
}
