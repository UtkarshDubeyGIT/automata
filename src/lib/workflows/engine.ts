import { creditCost } from "./credits";
import type { WorkflowGraph, WorkflowStep } from "./types";
import { TRIGGER_TYPES } from "./types";
import { validateGraph } from "./validate";

export type ModuleOutcome =
  | { outcome: "succeeded"; output: unknown; providerCredits?: number }
  | { outcome: "failed"; error: string; output?: unknown };

export interface JournalEvent {
  stepId: string;
  state: "started" | "succeeded" | "failed" | "waiting" | "approved" | "rejected";
  input?: unknown;
  output?: unknown;
  error?: string;
  credits?: number;
}

export interface ExecutionAdapter {
  execute(step: WorkflowStep, input: unknown, context: ExecutionContext): Promise<ModuleOutcome>;
  journal(event: JournalEvent): Promise<void>;
}

export interface ExecutionContext {
  trigger: unknown;
  steps: Record<string, unknown>;
}

export interface ExecutionResult {
  state: "succeeded" | "failed" | "waiting_approval";
  outputs: Record<string, unknown>;
  creditsUsed: number;
  error?: string;
  waiting?: { stepId: string; prompt: string; approveNext: string | null; rejectNext: string | null };
}

interface ExecuteWorkflowOptions {
  graph: WorkflowGraph;
  triggerData: unknown;
  adapter: ExecutionAdapter;
  existingOutputs?: Record<string, unknown>;
  resume?: { approvalStepId: string; decision: "approved" | "rejected" };
}

const TOKEN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function readPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (UNSAFE_KEYS.has(key) || value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

function lookup(expression: string, context: ExecutionContext): unknown {
  const parts = expression.trim().split(".");
  if (parts[0] === "trigger") return readPath(context.trigger, parts.slice(1).join("."));
  if (parts[0] === "steps" && parts[1]) return readPath(context.steps[parts[1]], parts.slice(2).join("."));
  return undefined;
}

export function resolveTemplates<T>(value: T, context: ExecutionContext): T {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (exact) return lookup(exact[1], context) as T;
    return value.replace(TOKEN, (_token, expression: string) => {
      const resolved = lookup(expression, context);
      return resolved === undefined || resolved === null ? "" : String(resolved);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, context)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !UNSAFE_KEYS.has(key))
        .map(([key, item]) => [key, resolveTemplates(item, context)]),
    ) as T;
  }
  return value;
}

function initialStep(options: ExecuteWorkflowOptions): string | null {
  if (!options.resume) return options.graph.start;
  const approval = options.graph.steps[options.resume.approvalStepId];
  if (!approval || approval.type !== "approval") throw new Error("Cannot resume: approval step does not exist.");
  return options.resume.decision === "approved" ? (approval.onApprove ?? approval.next ?? null) : (approval.onReject ?? null);
}

export async function executeWorkflow(options: ExecuteWorkflowOptions): Promise<ExecutionResult> {
  const graphErrors = validateGraph(options.graph);
  if (graphErrors.length) throw new Error(graphErrors.join(" "));

  const outputs = { ...(options.existingOutputs ?? {}) };
  const context: ExecutionContext = { trigger: options.triggerData, steps: outputs };
  let creditsUsed = 0;
  let current = initialStep(options);
  let previousOutput: unknown = options.triggerData;
  let visited = 0;

  if (options.resume) {
    await options.adapter.journal({
      stepId: options.resume.approvalStepId,
      state: options.resume.decision === "approved" ? "approved" : "rejected",
    });
  }

  while (current) {
    visited += 1;
    if (visited > Object.keys(options.graph.steps).length + 1) throw new Error("Execution exceeded the graph step limit.");
    const authoredStep = options.graph.steps[current];
    if (!authoredStep) throw new Error(`Execution cannot find step: ${current}.`);
    const step = resolveTemplates(structuredClone(authoredStep), context);

    if (TRIGGER_TYPES.has(step.type)) {
      outputs[step.id] = options.triggerData;
      await options.adapter.journal({ stepId: step.id, state: "succeeded", input: options.triggerData, output: options.triggerData, credits: 0 });
      previousOutput = options.triggerData;
      current = step.next ?? null;
      continue;
    }

    if (step.type === "approval") {
      const prompt = String(step.prompt ?? `Approve ${step.name}?`);
      await options.adapter.journal({ stepId: step.id, state: "waiting", input: previousOutput });
      return {
        state: "waiting_approval",
        outputs,
        creditsUsed,
        waiting: { stepId: step.id, prompt, approveNext: step.onApprove ?? step.next ?? null, rejectNext: step.onReject ?? null },
      };
    }

    await options.adapter.journal({ stepId: step.id, state: "started", input: previousOutput });
    let outcome: ModuleOutcome;
    try {
      outcome = await options.adapter.execute(step, previousOutput, context);
    } catch (error) {
      outcome = { outcome: "failed", error: error instanceof Error ? error.message : "Module execution failed." };
    }

    if (outcome.outcome === "failed") {
      await options.adapter.journal({ stepId: step.id, state: "failed", input: previousOutput, output: outcome.output, error: outcome.error, credits: 0 });
      return { state: "failed", outputs, creditsUsed, error: outcome.error };
    }

    const credits = creditCost({ type: step.type, outcome: "succeeded", providerCredits: outcome.providerCredits });
    creditsUsed += credits;
    outputs[step.id] = outcome.output;
    previousOutput = outcome.output;
    await options.adapter.journal({ stepId: step.id, state: "succeeded", output: outcome.output, credits });
    if (step.type === "filter") {
      const passed = Boolean((outcome.output as { passed?: unknown } | null)?.passed);
      current = passed ? (step.next ?? null) : (step.onFalse ?? null);
    } else if (step.type === "router") {
      const route = String((outcome.output as { route?: unknown } | null)?.route ?? "");
      current = step.cases?.[route] ?? step.next ?? null;
    } else {
      current = step.next ?? null;
    }
  }

  return { state: "succeeded", outputs, creditsUsed };
}
