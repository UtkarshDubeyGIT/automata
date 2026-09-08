import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { getWorkspaceContext } from "@/lib/workspace";
import { ToastProvider } from "@/components/ui/toast";
import { CreditsProvider } from "@/components/ui/credits";
import { Suspense } from "react";

export default async function ProductLayout({ children }: { children: ReactNode }) {
  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabaseClient();
    const { data } = (await supabase?.auth.getClaims()) ?? { data: null };
    if (!data?.claims?.sub) redirect("/login");
  }
  const ctx = await getWorkspaceContext();
  return (
    <ToastProvider>
      <CreditsProvider initialCredits={ctx.credits} initialPlan={ctx.plan}>
        <div className="flex h-dvh overflow-hidden bg-page">
          <a href="#main-content" className="sr-only z-50 rounded-control bg-card px-4 py-3 text-brand focus:not-sr-only focus:absolute focus:left-4 focus:top-4">Skip to content</a>
          <Suspense fallback={null}><Sidebar /></Suspense>
          <div className="flex min-w-0 flex-1 flex-col">
            <Topbar userName={ctx.userName} userEmail={ctx.userEmail} />
            <main id="main-content" className="scroll-thin flex-1 overflow-y-auto">
              <div className="mx-auto max-w-[1360px] px-5 py-6 md:px-10 md:py-9">{children}</div>
            </main>
          </div>
        </div>
      </CreditsProvider>
    </ToastProvider>
  );
}
