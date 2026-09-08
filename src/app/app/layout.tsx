import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { AppControls } from "@/components/app-shell/app-controls";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { ToastProvider } from "@/components/ui/toast";
import { CreditsProvider } from "@/components/ui/credits";
import { ThemeProvider } from "@/components/theme";

/**
 * The product shell: no sidebar, no topbar, just the page under two floating
 * clusters (the mark on the left, notifications and account on the right).
 *
 * The `h-dvh overflow-hidden` wrapper with an inner scrolling <main> stays on
 * purpose. It looks redundant next to `position: fixed` controls, but it is the
 * only thing stopping the background scrolling behind every Dialog — those are
 * plain `fixed inset-0` overlays with no scroll lock of their own.
 */
export default async function ProductLayout({ children }: { children: ReactNode }) {
  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabaseClient();
    const { data } = (await supabase?.auth.getClaims()) ?? { data: null };
    if (!data?.claims?.sub) redirect("/login");
  }
  const ctx = await getWorkspaceContext();
  return (
    <ThemeProvider>
      <ToastProvider>
        <CreditsProvider initialCredits={ctx.credits} initialPlan={ctx.plan}>
          <div className="flex h-dvh overflow-hidden bg-page">
            {/* z-[70]: above the floating cluster, which it would otherwise
                appear underneath when focused. */}
            <a href="#main-content" className="sr-only z-[70] rounded-control bg-card px-4 py-3 text-brand focus:not-sr-only focus:fixed focus:left-4 focus:top-4">Skip to content</a>
            <AppControls userName={ctx.userName} userEmail={ctx.userEmail} />
            <main id="main-content" className="scroll-thin flex-1 overflow-y-auto overscroll-contain">
              {/* Top padding clears the floating controls. */}
              <div className="mx-auto max-w-[1360px] px-5 pb-6 pt-20 md:px-10 md:pb-9 md:pt-24">{children}</div>
            </main>
          </div>
        </CreditsProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
