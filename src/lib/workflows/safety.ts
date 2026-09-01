import { outEdges, type WorkflowGraph, type WorkflowStep } from "./types";

interface SafetyIntent {
  allowUnattendedWrites: boolean;
}

function isExternalWrite(step: WorkflowStep): boolean {
  if (step.type === "app_action") return step.operation !== "read";
  if (step.type === "http_request") return !["GET", "HEAD", "OPTIONS"].includes(String(step.method ?? "POST").toUpperCase());
  return false;
}

function displayApp(app: string | undefined): string {
  if (!app) return "an external service";
  return app.charAt(0).toUpperCase() + app.slice(1);
}

function approvalIdFor(stepId: string, steps: Record<string, WorkflowStep>): string {
  const base = `approve_${stepId}`;
  if (!steps[base]) return base;
  let suffix = 2;
  while (steps[`${base}_${suffix}`]) suffix += 1;
  return `${base}_${suffix}`;
}

function replaceEdge(step: WorkflowStep, from: string, to: string): void {
  for (const key of ["next", "onFalse", "onApprove", "onReject"] as const) {
    if (step[key] === from) step[key] = to;
  }
  if (step.cases) {
    for (const [key, value] of Object.entries(step.cases)) {
      if (value === from) step.cases[key] = to;
    }
  }
}

export function applySafetyDefaults(graph: WorkflowGraph, intent: SafetyIntent): WorkflowGraph {
  if (intent.allowUnattendedWrites) return graph;

  const safe = structuredClone(graph);
  const authored = Object.values(safe.steps);

  for (const target of authored) {
    if (!isExternalWrite(target)) continue;

    const incoming = Object.values(safe.steps).filter((step) => outEdges(step).includes(target.id));
    if (incoming.length > 0 && incoming.every((step) => step.type === "approval")) continue;

    const approvalId = approvalIdFor(target.id, safe.steps);
    safe.steps[approvalId] = {
      id: approvalId,
      type: "approval",
      name: `Approve ${target.name}`,
      prompt: `Approve ${target.name} before it changes data in ${displayApp(target.app)}?`,
      onApprove: target.id,
      onReject: null,
      next: null,
    };

    if (safe.start === target.id) safe.start = approvalId;
    for (const predecessor of incoming) {
      if (predecessor.type !== "approval") replaceEdge(predecessor, target.id, approvalId);
    }
  }

  return safe;
}
