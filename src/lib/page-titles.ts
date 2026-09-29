import { BRAND } from "@/config/brand";

export const WORKFLOW_TAB_TITLES = {
  create: "Create a Workflow",
  workflows: "Workflows",
  runs: "Run History",
  attention: "Needs Your Attention",
} as const;

export type WorkflowTab = keyof typeof WORKFLOW_TAB_TITLES;

export function pageTitle(page: string): string {
  return `${page} | ${BRAND.name}`;
}

export function workflowTabTitle(tab: string | null | undefined): string {
  const key: WorkflowTab = tab === "workflows" || tab === "runs" || tab === "attention"
    ? tab
    : "create";
  return WORKFLOW_TAB_TITLES[key];
}
