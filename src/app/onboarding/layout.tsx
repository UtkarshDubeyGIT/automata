import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { shouldOnboard } from "@/lib/onboarding/gate";
import { ThemeProvider } from "@/components/theme";
import { ToastProvider } from "@/components/ui/toast";

/**
 * The first-run shell.
 *
 * Deliberately outside `/app`: that layout wraps its children in a padded
 * `max-w-[1360px]` column and renders a fixed control cluster at `z-[60]`,
 * both of which a full-bleed flow would spend its life fighting. Sitting at the
 * top level also orders this ahead of the welcome-bonus modal, which fires on
 * the first `/app` render rather than here.
 */
export default async function OnboardingLayout({ children }: { children: ReactNode }) {
  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabaseClient();
    const { data } = (await supabase?.auth.getClaims()) ?? { data: null };
    if (!data?.claims?.sub) redirect("/login");
  }

  // The mirror of the product layout's gate. Someone who already finished or
  // skipped has no business back here; without this, a bookmark or the back
  // button would replay the flow over a configured workspace.
  const ctx = await getWorkspaceContext();
  if (!shouldOnboard(ctx)) redirect("/app/workflows");

  return (
    <ThemeProvider>
      <ToastProvider>
        <div className="min-h-dvh bg-page">{children}</div>
      </ToastProvider>
    </ThemeProvider>
  );
}
