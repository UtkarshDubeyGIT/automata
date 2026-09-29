import type { Metadata } from "next";
import type { ReactNode } from "react";

import { resolveRequestContext } from "@/lib/workspace";

type WorkflowLayoutProps = {
  children: ReactNode;
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: WorkflowLayoutProps): Promise<Metadata> {
  try {
    const [{ id }, context] = await Promise.all([params, resolveRequestContext()]);
    if (!context.supabase || !context.workspaceId) return { title: "Workflow" };

    const { data, error } = await context.supabase
      .from("workflows")
      .select("name")
      .eq("id", id)
      .eq("workspace_id", context.workspaceId)
      .maybeSingle();

    const name = !error && typeof data?.name === "string" ? data.name.trim() : "";
    return { title: name || "Workflow" };
  } catch {
    return { title: "Workflow" };
  }
}

export default function WorkflowLayout({ children }: WorkflowLayoutProps) {
  return children;
}
