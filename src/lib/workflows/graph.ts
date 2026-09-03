import type { StepDef, WorkflowGraph } from "./types";

/**
 * Pure structural helpers for a workflow graph — no UI, no AI, no I/O.
 *
 * Everything that needs to *walk* a graph (validation, the view-model
 * derivation, the visual editor's mutations) shares these primitives so the
 * notion of "an edge" is defined exactly once. Adding a routing key here
 * teaches the whole system about it.
 */

/** Keys on a StepDef that carry routing rather than config. */
export const ROUTING_KEYS = new Set([
  "next",
  "on_approve",
  "on_reject",
  "on_fail",
  "branch_on",
  "cases",
  "default",
]);

/**
 * A single outgoing connection, addressed by the step it leaves and which
 * routing slot it occupies. Case edges use the `case:<value>` form so the
 * editor can insert into one branch of a fan-out without touching the others.
 */
export type EdgeSlot = "next" | "on_approve" | "on_reject" | "on_fail" | "default" | string;

export interface EdgeRef {
  from: string;
  slot: EdgeSlot;
}

export function isCaseSlot(slot: EdgeSlot): boolean {
  return slot.startsWith("case:");
}

export function caseValue(slot: EdgeSlot): string {
  return slot.slice("case:".length);
}

/** Every slot this step actually uses, in display order. */
export function edgeSlots(step: StepDef): EdgeSlot[] {
  const slots: EdgeSlot[] = [];
  if ("on_approve" in step || "on_reject" in step) {
    slots.push("on_approve", "on_reject");
  }
  if (step.cases) {
    for (const value of Object.keys(step.cases)) slots.push(`case:${value}`);
    slots.push("default");
  }
  // A filter that simply stops on failure stays a single-lane step; it only
  // becomes a fork once the user routes the failing case somewhere.
  if (typeof step.on_fail === "string" && step.on_fail) slots.push("on_fail");
  if (!slots.length || "next" in step) slots.unshift("next");
  return [...new Set(slots)];
}

/** Read the target of one slot (null = terminate this path). */
export function getEdge(step: StepDef, slot: EdgeSlot): string | null {
  if (isCaseSlot(slot)) return step.cases?.[caseValue(slot)] ?? null;
  const value = step[slot];
  return typeof value === "string" && value ? value : null;
}

/** Point one slot at a new target. Mutates the step (callers clone first). */
export function setEdge(step: StepDef, slot: EdgeSlot, target: string | null): void {
  if (isCaseSlot(slot)) {
    step.cases = { ...(step.cases ?? {}), [caseValue(slot)]: target };
    return;
  }
  step[slot] = target;
}

/** All step ids this step can route to. */
export function outEdges(step: StepDef): string[] {
  const edges = [
    step.next,
    step.on_approve,
    step.on_reject,
    step.on_fail,
    step.default,
    ...Object.values(step.cases ?? {}),
  ];
  return edges.filter((e): e is string => typeof e === "string" && e.length > 0);
}

/** Execution-order traversal (DFS preorder over routing edges, deduped). */
export function orderedStepIds(graph: WorkflowGraph): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [graph.start];
  while (stack.length) {
    const id = stack.shift()!;
    if (seen.has(id) || !graph.steps[id]) continue;
    seen.add(id);
    order.push(id);
    stack.unshift(...outEdges(graph.steps[id]));
  }
  return order;
}

/** Steps that exist but are unreachable from the start node. */
export function orphanIds(graph: WorkflowGraph): string[] {
  const reachable = new Set(orderedStepIds(graph));
  return Object.keys(graph.steps).filter((id) => !reachable.has(id));
}

/** Set of node ids from which `target` is reachable (its ancestors). */
export function ancestors(graph: WorkflowGraph, target: string): Set<string> {
  const result = new Set<string>();
  for (const startId of Object.keys(graph.steps)) {
    if (startId === target) continue;
    const seen = new Set<string>();
    const stack = [startId];
    let reached = false;
    while (stack.length) {
      const cur = stack.pop()!;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const next of outEdges(graph.steps[cur] ?? ({} as StepDef))) {
        if (next === target) reached = true;
        stack.push(next);
      }
    }
    if (reached) result.add(startId);
  }
  return result;
}

/**
 * The first routing cycle reachable from the start, as the path that closes it
 * (["draft", "review", "draft"]), or null when the graph is acyclic.
 */
export function findCycle(graph: WorkflowGraph): string[] | null {
  const state = new Map<string, "open" | "closed">();
  const path: string[] = [];

  const walk = (id: string): string[] | null => {
    if (state.get(id) === "closed") return null;
    if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
    if (!graph.steps[id]) return null;
    state.set(id, "open");
    path.push(id);
    for (const next of outEdges(graph.steps[id])) {
      const found = walk(next);
      if (found) return found;
    }
    path.pop();
    state.set(id, "closed");
    return null;
  };

  return graph.steps[graph.start] ? walk(graph.start) : null;
}

/** True when at least one path from the start terminates. */
export function hasTerminal(graph: WorkflowGraph): boolean {
  const seen = new Set<string>();
  const stack: (string | null)[] = [graph.start];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === null) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const step = graph.steps[cur];
    if (!step) return true;
    const nexts = [
      step.next,
      step.on_approve,
      step.on_reject,
      step.on_fail,
      step.default,
      ...Object.values(step.cases ?? {}),
    ];
    if (!nexts.length || nexts.some((n) => n == null)) return true;
    stack.push(...nexts.filter((n): n is string => typeof n === "string"));
  }
  return false;
}

/** Every step id referenced by a {{steps.<id>.…}} template inside `value`. */
const REF_RE = /\{\{\s*steps\.([A-Za-z0-9_]+)\./g;

export function refsIn(value: unknown): Set<string> {
  const found = new Set<string>();
  if (typeof value === "string") {
    for (const m of value.matchAll(REF_RE)) found.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) for (const r of refsIn(v)) found.add(r);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) for (const r of refsIn(v)) found.add(r);
  }
  return found;
}

/**
 * Every {{steps.<id>.<path>}} reference inside `value`, split into the step it
 * points at and the field path within that step's output.
 */
export interface StepRef {
  stepId: string;
  /** Dotted path after the step id, e.g. "result.reply" or "event.rating". */
  path: string;
}

const REF_PATH_RE = /\{\{\s*steps\.([A-Za-z0-9_]+)\.([A-Za-z0-9_.]+?)\s*\}\}/g;

export function refPathsIn(value: unknown): StepRef[] {
  const found: StepRef[] = [];
  if (typeof value === "string") {
    for (const m of value.matchAll(REF_PATH_RE)) found.push({ stepId: m[1], path: m[2] });
  } else if (Array.isArray(value)) {
    for (const v of value) found.push(...refPathsIn(v));
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) found.push(...refPathsIn(v));
  }
  return found;
}

/** Config-only entries of a step (routing + type stripped). */
export function configEntries(step: StepDef): [string, unknown][] {
  return Object.entries(step).filter(([k]) => !ROUTING_KEYS.has(k) && k !== "type");
}

/** Structural deep clone — graphs are plain JSON, so this is exact. */
export function cloneGraph(graph: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph;
}
