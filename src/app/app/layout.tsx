import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { Sidebar } from "@/components/app-shell/sidebar";
import { Topbar } from "@/components/app-shell/topbar";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createServerSupabaseClient } from "@/lib/supabase/server";

import "./product-shell.css";

export default async function ProductLayout({ children }: { children: ReactNode }) {
  if (isSupabaseConfigured()) {
    const supabase = await createServerSupabaseClient();
    const { data } = (await supabase?.auth.getClaims()) ?? { data: null };
    if (!data?.claims?.sub) redirect("/login");
  }
  return <div className="product-shell"><Sidebar /><div className="product-main"><Topbar />{children}</div></div>;
}
