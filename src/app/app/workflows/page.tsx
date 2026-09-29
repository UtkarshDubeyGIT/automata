import type { Metadata } from "next";

import { workflowTabTitle } from "@/lib/page-titles";

type WorkflowsPageProps = {
  searchParams: Promise<{ tab?: string | string[] }>;
};

export async function generateMetadata({ searchParams }: WorkflowsPageProps): Promise<Metadata> {
  const { tab } = await searchParams;
  return { title: workflowTabTitle(Array.isArray(tab) ? tab[0] : tab) };
}

export { default } from "./workflows-client";
