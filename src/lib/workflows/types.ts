export type StepType =
  | "manual_trigger"
  | "schedule_trigger"
  | "webhook_trigger"
  | "app_event_trigger"
  | "app_action"
  | "http_request"
  | "ai"
  | "image"
  | "transform"
  | "filter"
  | "router"
  | "iterator"
  | "aggregator"
  | "approval"
  | "log";

export interface WorkflowStep {
  id: string;
  type: StepType;
  name: string;
  next?: string | null;
  onFalse?: string | null;
  onApprove?: string | null;
  onReject?: string | null;
  cases?: Record<string, string | null>;
  app?: string;
  action?: string;
  operation?: "read" | "write";
  method?: string;
  prompt?: string;
  [key: string]: unknown;
}

export interface WorkflowGraph {
  start: string;
  steps: Record<string, WorkflowStep>;
}

export const TRIGGER_TYPES = new Set<StepType>([
  "manual_trigger",
  "schedule_trigger",
  "webhook_trigger",
  "app_event_trigger",
]);

export function outEdges(step: WorkflowStep): Array<string> {
  const edges = [step.next, step.onFalse, step.onApprove, step.onReject, ...Object.values(step.cases ?? {})];
  return edges.filter((edge): edge is string => typeof edge === "string" && edge.length > 0);
}
