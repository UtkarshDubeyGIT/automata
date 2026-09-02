import { outEdges, TRIGGER_TYPES, type WorkflowGraph, type WorkflowStep } from "./types";

export interface NodePosition { x: number; y: number }
export type WorkflowPositions = Record<string, NodePosition>;
export type EditorEdgeSlot = "next" | "onFalse" | "onApprove" | "onReject" | `case:${string}`;
export interface EditorEdgeRef { from: string; slot: EditorEdgeSlot }
export interface DraftIssue { code: "trigger" | "cycle" | "missing" | "disconnected"; stepId?: string; message: string }
export interface VariableChoice { stepId: string; stepName: string; path: string; label: string; expression: string }

export function validateDraftEnvelope(graph: WorkflowGraph, positions: WorkflowPositions): string[] {
  if (!graph || typeof graph.start !== "string" || !graph.steps || typeof graph.steps !== "object") return ["A workflow graph is required."];
  if (Object.keys(graph.steps).length > 100) return ["Workflows support up to 100 modules."];
  for (const [id, step] of Object.entries(graph.steps)) {
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || step.id !== id) return ["Every module needs a stable identifier."];
  }
  for (const position of Object.values(positions ?? {})) {
    if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return ["Canvas positions must be finite numbers."];
  }
  return [];
}

function clone(graph: WorkflowGraph): WorkflowGraph {
  return structuredClone(graph);
}

function targetOf(step: WorkflowStep, slot: EditorEdgeSlot): string | null {
  if (slot.startsWith("case:")) return step.cases?.[slot.slice(5)] ?? null;
  const value = step[slot];
  return typeof value === "string" ? value : null;
}

function setTarget(step: WorkflowStep, slot: EditorEdgeSlot, target: string | null): void {
  if (slot.startsWith("case:")) {
    step.cases = { ...(step.cases ?? {}), [slot.slice(5)]: target };
    return;
  }
  step[slot] = target;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visiting.has(id)) return true;
    if (visited.has(id) || !graph.steps[id]) return false;
    visiting.add(id);
    if (outEdges(graph.steps[id]).some(visit)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return Object.keys(graph.steps).some(visit);
}

export function connectSteps(graph: WorkflowGraph, edge: EditorEdgeRef, target: string | null): WorkflowGraph {
  if (!graph.steps[edge.from] || (target && !graph.steps[target]) || edge.from === target) return graph;
  if (targetOf(graph.steps[edge.from], edge.slot) === target) return graph;
  const next = clone(graph);
  setTarget(next.steps[edge.from], edge.slot, target);
  return hasCycle(next) ? graph : next;
}

export function removeStepDetached(graph: WorkflowGraph, id: string): WorkflowGraph {
  if (!graph.steps[id] || id === graph.start) return graph;
  const next = clone(graph);
  delete next.steps[id];
  for (const step of Object.values(next.steps)) {
    for (const key of ["next", "onFalse", "onApprove", "onReject"] as const) {
      if (step[key] === id) step[key] = null;
    }
    if (step.cases) {
      for (const [key, value] of Object.entries(step.cases)) if (value === id) step.cases[key] = null;
    }
  }
  return next;
}

function reachable(graph: WorkflowGraph): Set<string> {
  const seen = new Set<string>();
  const queue = graph.steps[graph.start] ? [graph.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const target of outEdges(graph.steps[id])) if (!seen.has(target)) queue.push(target);
  }
  return seen;
}

export function draftIssues(graph: WorkflowGraph): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const start = graph.steps[graph.start];
  if (!start || !TRIGGER_TYPES.has(start.type)) issues.push({ code: "trigger", stepId: graph.start, message: "Choose one trigger to start this workflow." });
  for (const step of Object.values(graph.steps)) {
    for (const target of outEdges(step)) if (!graph.steps[target]) issues.push({ code: "missing", stepId: step.id, message: `${step.name} points to a missing module.` });
  }
  if (hasCycle(graph)) issues.push({ code: "cycle", message: "Remove the loop before publishing." });
  const seen = reachable(graph);
  const disconnected = Object.keys(graph.steps).filter((id) => !seen.has(id));
  if (disconnected.length) issues.push({ code: "disconnected", stepId: disconnected[0], message: `${disconnected.length} module${disconnected.length === 1 ? " is" : "s are"} not connected to the trigger.` });
  return issues;
}

export function arrangeGraph(graph: WorkflowGraph): WorkflowPositions {
  const depth = new Map<string, number>();
  const order = new Map<string, number>();
  const discovered: string[] = [];
  const queue = graph.steps[graph.start] ? [graph.start] : [];
  if (queue.length) depth.set(graph.start, 0);
  while (queue.length) {
    const id = queue.shift()!;
    if (order.has(id)) continue;
    order.set(id, discovered.length);
    discovered.push(id);
    for (const target of outEdges(graph.steps[id])) {
      if (!graph.steps[target] || depth.has(target)) continue;
      depth.set(target, (depth.get(id) ?? 0) + 1);
      queue.push(target);
    }
  }

  const reachable = new Set(discovered);
  const incoming = new Map(discovered.map((id) => [id, 0]));
  for (const id of discovered) {
    for (const target of new Set(outEdges(graph.steps[id]))) {
      if (reachable.has(target)) incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }
  const ready = discovered.filter((id) => incoming.get(id) === 0);
  while (ready.length) {
    ready.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    const id = ready.shift()!;
    for (const target of new Set(outEdges(graph.steps[id]))) {
      if (!reachable.has(target)) continue;
      depth.set(target, Math.max(depth.get(target) ?? 0, (depth.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (incoming.get(target) === 0) ready.push(target);
    }
  }

  const levels = new Map<number, string[]>();
  for (const id of discovered) {
    const value = depth.get(id) ?? 0;
    levels.set(value, [...(levels.get(value) ?? []), id]);
  }
  const result: WorkflowPositions = {};
  const widestLevel = Math.max(1, ...[...levels.values()].map((ids) => ids.length));
  const rowGap = 170;
  for (const [level, ids] of levels) ids.forEach((id, lane) => {
    result[id] = { x: 96 + level * 260, y: 120 + ((widestLevel - ids.length) / 2 + lane) * rowGap };
  });

  const loose = Object.keys(graph.steps).filter((id) => !reachable.has(id)).sort();
  const looseTop = 120 + (widestLevel - 1) * rowGap + 220;
  loose.forEach((id, index) => {
    result[id] = { x: 96 + (index % 4) * 260, y: looseTop + Math.floor(index / 4) * rowGap };
  });
  return result;
}

function topologyOf(graph: WorkflowGraph): string {
  return JSON.stringify(Object.keys(graph.steps).sort().map((id) => [id, outEdges(graph.steps[id])]));
}

/** Reflow structural edits while leaving configuration and manual movement alone. */
export function positionsAfterGraphChange(
  before: WorkflowGraph,
  after: WorkflowGraph,
  current: WorkflowPositions,
): WorkflowPositions {
  return topologyOf(before) === topologyOf(after) ? current : arrangeGraph(after);
}

function legacyGeneratedPositions(graph: WorkflowGraph): WorkflowPositions {
  const depth = new Map<string, number>();
  if (graph.steps[graph.start]) depth.set(graph.start, 0);
  const queue = graph.steps[graph.start] ? [graph.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    const nextDepth = (depth.get(id) ?? 0) + 1;
    for (const target of outEdges(graph.steps[id])) {
      if (graph.steps[target] && !depth.has(target)) { depth.set(target, nextDepth); queue.push(target); }
    }
  }
  let orphanDepth = Math.max(0, ...depth.values()) + 1;
  for (const id of Object.keys(graph.steps).sort()) if (!depth.has(id)) depth.set(id, orphanDepth++);
  const levels = new Map<number, string[]>();
  for (const [id, value] of depth) levels.set(value, [...(levels.get(value) ?? []), id]);
  const result: WorkflowPositions = {};
  for (const [level, ids] of levels) ids.sort().forEach((id, lane) => {
    result[id] = { x: 96 + level * 260, y: 120 + lane * 150 };
  });
  return result;
}

/** Upgrade only positions produced by the previous arranger; preserve hand layouts. */
export function initialCanvasPositions(graph: WorkflowGraph, saved: WorkflowPositions): WorkflowPositions {
  const ids = Object.keys(graph.steps);
  const savedIds = Object.keys(saved ?? {});
  const complete = ids.every((id) => saved[id]) && savedIds.every((id) => graph.steps[id]);
  if (!complete) return { ...arrangeGraph(graph), ...Object.fromEntries(savedIds.filter((id) => graph.steps[id]).map((id) => [id, saved[id]])) };
  const legacy = legacyGeneratedPositions(graph);
  const generated = ids.every((id) => saved[id].x === legacy[id]?.x && saved[id].y === legacy[id]?.y);
  return generated ? arrangeGraph(graph) : saved;
}

function outputPaths(step: WorkflowStep): Array<{ path: string; label: string }> {
  if (TRIGGER_TYPES.has(step.type)) {
    const fields = Array.isArray(step.fields) ? step.fields.filter((v): v is string => typeof v === "string") : [];
    return fields.map((field) => ({ path: `input.${field}`, label: field }));
  }
  if (Array.isArray(step.outputs)) return step.outputs.filter((v): v is string => typeof v === "string").map((path) => ({ path, label: path }));
  if (step.type === "ai") return [{ path: step.output === "json" ? "result" : "text", label: step.output === "json" ? "Result" : "Text" }];
  if (step.type === "image") return [{ path: "url", label: "Image URL" }];
  if (step.type === "app_action") return [{ path: "result", label: step.operation === "read" ? "Result" : "Action result" }];
  if (step.type === "http_request") return [{ path: "status", label: "Status" }, { path: "body", label: "Response body" }];
  if (step.type === "transform") return [{ path: "result", label: "Transformed data" }];
  if (step.type === "filter") return [{ path: "passed", label: "Passed" }, { path: "input", label: "Input" }];
  if (step.type === "router") return [{ path: "route", label: "Selected route" }, { path: "input", label: "Input" }];
  if (step.type === "approval") return [{ path: "decision", label: "Decision" }];
  if (step.type === "log") return [{ path: "value", label: "Logged value" }];
  return [];
}

export function upstreamVariables(graph: WorkflowGraph, stepId: string, observed: Record<string, string[]> = {}): VariableChoice[] {
  const parents = new Map<string, string[]>();
  for (const [id, step] of Object.entries(graph.steps)) for (const target of outEdges(step)) parents.set(target, [...(parents.get(target) ?? []), id]);
  const upstream = new Set<string>();
  const queue = [...(parents.get(stepId) ?? [])];
  while (queue.length) {
    const id = queue.shift()!;
    if (upstream.has(id)) continue;
    upstream.add(id);
    queue.push(...(parents.get(id) ?? []));
  }
  return Object.keys(graph.steps).filter((id) => upstream.has(id)).flatMap((id) => {
    const declared = outputPaths(graph.steps[id]);
    const seen = new Set(declared.map((output) => output.path));
    const outputs = [...declared, ...(observed[id] ?? []).filter((path) => !seen.has(path)).map((path) => ({ path, label: path.split(".").at(-1)?.replaceAll("_", " ") ?? path }))];
    return outputs.map((output) => ({ stepId: id, stepName: graph.steps[id].name, path: output.path, label: output.label, expression: `{{steps.${id}.${output.path}}}` }));
  });
}

export function diffWorkflowGraphs(before: WorkflowGraph, after: WorkflowGraph): { added: string[]; removed: string[]; changed: string[] } {
  const added = Object.keys(after.steps).filter((id) => !before.steps[id]).map((id) => after.steps[id].name);
  const removed = Object.keys(before.steps).filter((id) => !after.steps[id]).map((id) => before.steps[id].name);
  const changed = Object.keys(after.steps).filter((id) => before.steps[id] && JSON.stringify(before.steps[id]) !== JSON.stringify(after.steps[id])).map((id) => after.steps[id].name);
  return { added, removed, changed };
}
