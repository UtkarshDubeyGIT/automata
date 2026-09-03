import { newStepFrom, nodeSpec, outputsOf, type PaletteBlock, idSeed } from "./blocks";
import {
  ancestors,
  caseValue,
  cloneGraph,
  configEntries,
  edgeSlots,
  findCycle,
  getEdge,
  isCaseSlot,
  orderedStepIds,
  outEdges,
  setEdge,
  type EdgeRef,
  type EdgeSlot,
} from "./graph";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * Editing operations for the visual builder — every user gesture on the canvas
 * (insert, delete, move, reorder, re-wire, rename) expressed as a pure
 * graph → graph function.
 *
 * Keeping mutations here (rather than inside React state handlers) is what
 * makes the visual editor and the AI builder interchangeable: both produce a
 * plain graph, both go through the same validation, and either can pick up
 * where the other left off.
 *
 * Every function returns a NEW graph; the input is never mutated.
 */

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** A readable, unique, snake_case step id — ids appear in {{steps.<id>.…}}. */
export function uniqueStepId(graph: WorkflowGraph, seed: string): string {
  const base =
    seed
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32) || "step";
  if (!graph.steps[base]) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base}_${i}`;
    if (!graph.steps[candidate]) return candidate;
  }
  return `${base}_${Object.keys(graph.steps).length + 1}`;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Insert a block onto one edge: the new step takes over that slot and inherits
 * whatever the slot used to point at, so the chain stays connected.
 *
 * Approvals and branches get their own outgoing wiring: an approval sends both
 * decisions onward (reject terminates), a branch starts with two named paths.
 */
export function insertOnEdge(
  graph: WorkflowGraph,
  edge: EdgeRef,
  block: PaletteBlock,
): { graph: WorkflowGraph; stepId: string } {
  const next = cloneGraph(graph);
  const parent = next.steps[edge.from];
  if (!parent) return { graph, stepId: edge.from };

  const downstream = getEdge(parent, edge.slot);
  const id = uniqueStepId(next, idSeed(block));
  const step = newStepFrom(block);
  wireFresh(step, downstream);

  next.steps[id] = step;
  setEdge(parent, edge.slot, id);
  return { graph: next, stepId: id };
}

/** Wire a newly created step so every one of its slots has a sensible target. */
function wireFresh(step: StepDef, downstream: string | null): void {
  const spec = nodeSpec(step.type);
  const routing = spec?.routing ?? ["next"];
  if (routing.includes("on_approve")) {
    step.on_approve = downstream;
    step.on_reject = null;
    return;
  }
  if (step.type === "branch") {
    // Two starter paths, both landing where the chain already went.
    step.branch_on = String(step.key ?? "category");
    step.cases = { a: downstream, b: downstream };
    step.default = downstream;
    return;
  }
  if (routing.includes("on_fail")) {
    step.next = downstream;
    step.on_fail = null; // failing the filter ends the run
    return;
  }
  step.next = downstream;
}

/** Replace the trigger (start node) with a different trigger block, keeping the chain. */
export function replaceTrigger(
  graph: WorkflowGraph,
  block: PaletteBlock,
): { graph: WorkflowGraph; stepId: string } {
  const next = cloneGraph(graph);
  const oldId = next.start;
  const downstream = getEdge(next.steps[oldId] ?? ({ type: "manual_trigger_input" } as StepDef), "next");

  delete next.steps[oldId];
  const id = uniqueStepId(next, idSeed(block));
  const step = newStepFrom(block);
  step.next = downstream;
  next.steps[id] = step;
  next.start = id;

  // Anything that referenced the old trigger's data now points at the new one.
  return { graph: renameReferences(next, oldId, id), stepId: id };
}

/** Add a step at the end of the path that flows out of `fromId`. */
export function appendAfter(
  graph: WorkflowGraph,
  fromId: string,
  block: PaletteBlock,
): { graph: WorkflowGraph; stepId: string } {
  const tail = terminalEdge(graph, fromId);
  return insertOnEdge(graph, tail, block);
}

/** Walk `next` links from a step until a slot points at nothing. */
export function terminalEdge(graph: WorkflowGraph, fromId: string): EdgeRef {
  let cursor = fromId;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cursor)) return { from: cursor, slot: "next" };
    seen.add(cursor);
    const step = graph.steps[cursor];
    if (!step) return { from: fromId, slot: "next" };
    const slot = edgeSlots(step)[0] ?? "next";
    const target = getEdge(step, slot);
    if (!target) return { from: cursor, slot };
    cursor = target;
  }
}

// ---------------------------------------------------------------------------
// Remove / move / duplicate
// ---------------------------------------------------------------------------

/**
 * Delete a step and heal the graph: everything that pointed at it is re-pointed
 * at its own primary outgoing target. The trigger can't be deleted (use
 * `replaceTrigger`); deleting a branch keeps its default path.
 */
export function removeStep(graph: WorkflowGraph, id: string): WorkflowGraph {
  if (!graph.steps[id] || graph.start === id) return graph;
  const next = cloneGraph(graph);
  const victim = next.steps[id];
  const heir = primaryTarget(victim);

  delete next.steps[id];
  for (const step of Object.values(next.steps)) {
    for (const slot of edgeSlots(step)) {
      if (getEdge(step, slot) === id) setEdge(step, slot, heir);
    }
  }
  return pruneOrphans(next);
}

/** The step a deleted node hands its inbound traffic to. */
function primaryTarget(step: StepDef): string | null {
  if (step.type === "human_approval") return step.on_approve ?? step.on_reject ?? null;
  if (step.type === "branch") return step.default ?? Object.values(step.cases ?? {})[0] ?? null;
  return step.next ?? null;
}

/**
 * Drop steps no longer reachable from the start. Deleting the head of a branch
 * path would otherwise leave its tail stranded in the jsonb forever.
 */
export function pruneOrphans(graph: WorkflowGraph): WorkflowGraph {
  const reachable = new Set(orderedStepIds(graph));
  if (reachable.size === Object.keys(graph.steps).length) return graph;
  const next: WorkflowGraph = { start: graph.start, steps: {} };
  for (const id of Object.keys(graph.steps)) {
    if (reachable.has(id)) next.steps[id] = graph.steps[id];
  }
  return next;
}

/**
 * Swap a step with its neighbour along the linear chain. Only offered when
 * both steps are plain single-`next` nodes — reordering around a fan-out has
 * no unambiguous meaning, so the editor hides the control instead of guessing.
 */
export function canMove(graph: WorkflowGraph, id: string, dir: "up" | "down"): boolean {
  return moveStep(graph, id, dir) !== graph;
}

export function moveStep(graph: WorkflowGraph, id: string, dir: "up" | "down"): WorkflowGraph {
  const step = graph.steps[id];
  if (!step || graph.start === id) return graph;
  if (!isLinear(step)) return graph;

  const parentId = soleParent(graph, id);
  if (!parentId) return graph;
  const parent = graph.steps[parentId];

  if (dir === "up") {
    // Can't move above the trigger, and the parent must itself be linear.
    if (parentId === graph.start || !isLinear(parent)) return graph;
    const grandparentId = soleParent(graph, parentId);
    if (!grandparentId) return graph;

    const next = cloneGraph(graph);
    const g = next.steps[grandparentId];
    const p = next.steps[parentId];
    const s = next.steps[id];
    const after = s.next ?? null;

    setEdge(g, slotPointingAt(g, parentId)!, id);
    s.next = parentId;
    p.next = after;
    return next;
  }

  const childId = step.next ?? null;
  if (!childId) return graph;
  const child = graph.steps[childId];
  if (!child || !isLinear(child)) return graph;

  const next = cloneGraph(graph);
  const p = next.steps[parentId];
  const s = next.steps[id];
  const c = next.steps[childId];
  const after = c.next ?? null;

  setEdge(p, slotPointingAt(p, id)!, childId);
  c.next = id;
  s.next = after;
  return next;
}

/**
 * Drag-and-drop reordering: detach `id` from wherever it currently sits and
 * splice it onto `edge` instead.
 *
 * `moveStep` only swaps with an immediate neighbour; this is the canvas gesture
 * of picking a circle up and dropping it on a different arrow, which can move a
 * step across the whole workflow — including into or out of a branch path.
 *
 * Only linear steps can be dragged, for the same reason `moveStep` refuses to
 * reorder around a fan-out: a branch dropped on one arrow gives no answer to
 * which of ITS paths continues from there. Anything illegal returns the graph
 * unchanged, so the caller can hand the gesture straight to `apply()` and a
 * refused drop simply snaps back.
 */
export function moveStepToEdge(graph: WorkflowGraph, id: string, edge: EdgeRef): WorkflowGraph {
  const moving = graph.steps[id];
  const parent = graph.steps[edge.from];
  if (!moving || !parent || graph.start === id) return graph;
  if (!isLinear(moving)) return graph;
  // Nothing can hang off itself, and dropping a step back on the arrow it
  // already occupies is a no-op rather than a rewrite.
  if (edge.from === id || getEdge(parent, edge.slot) === id) return graph;

  const next = cloneGraph(graph);
  // Detach: everything pointing at the step is re-pointed past it, exactly as
  // `removeStep` heals the chain — except the step itself survives.
  const heir = next.steps[id].next ?? null;
  for (const [stepId, step] of Object.entries(next.steps)) {
    if (stepId === id) continue;
    for (const slot of edgeSlots(step)) {
      if (getEdge(step, slot) === id) setEdge(step, slot, heir);
    }
  }

  // Splice: the step takes over the slot and inherits whatever it pointed at.
  const host = next.steps[edge.from];
  next.steps[id].next = getEdge(host, edge.slot);
  setEdge(host, edge.slot, id);

  // Dropping a step onto an arrow inside its own downstream path is legal and
  // common; dropping it somewhere that closes a loop is not, and is cheaper to
  // detect than to reason about up front.
  return findCycle(next) ? graph : pruneOrphans(next);
}

function isLinear(step: StepDef | undefined): boolean {
  if (!step) return false;
  if (step.cases || step.on_approve !== undefined || step.on_reject !== undefined) return false;
  if (step.on_fail) return false;
  return true;
}

function slotPointingAt(step: StepDef, target: string): EdgeSlot | null {
  for (const slot of edgeSlots(step)) {
    if (getEdge(step, slot) === target) return slot;
  }
  return null;
}

/** The single step routing into `id`, or null when it's 0 or many. */
function soleParent(graph: WorkflowGraph, id: string): string | null {
  const parents = Object.entries(graph.steps).filter(([, step]) => outEdges(step).includes(id));
  return parents.length === 1 ? parents[0][0] : null;
}

/** Copy a step in place, directly after the original. */
export function duplicateStep(
  graph: WorkflowGraph,
  id: string,
): { graph: WorkflowGraph; stepId: string } {
  const step = graph.steps[id];
  if (!step || graph.start === id || !isLinear(step)) return { graph, stepId: id };
  const next = cloneGraph(graph);
  const copyId = uniqueStepId(next, `${id}_copy`);
  const copy: StepDef = JSON.parse(JSON.stringify(step)) as StepDef;
  copy.title = `${String(step.title ?? id)} (copy)`;
  copy.next = step.next ?? null;
  next.steps[copyId] = copy;
  next.steps[id].next = copyId;
  return { graph: next, stepId: copyId };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/** Merge a config patch into one step. Undefined values delete the key. */
export function updateStep(
  graph: WorkflowGraph,
  id: string,
  patch: Record<string, unknown>,
): WorkflowGraph {
  if (!graph.steps[id]) return graph;
  const next = cloneGraph(graph);
  const step = next.steps[id];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete step[k];
    else step[k] = v;
  }
  // A branch's routing key mirrors its config key — keep them in lockstep so
  // the engine routes on the value the user actually chose.
  if (step.type === "branch" && typeof step.key === "string") {
    step.branch_on = step.key;
  }
  return next;
}

/** Rename a case on a branch, preserving its target and position. */
export function renameCase(
  graph: WorkflowGraph,
  id: string,
  from: string,
  to: string,
): WorkflowGraph {
  const step = graph.steps[id];
  if (!step?.cases || from === to || !to.trim()) return graph;
  const next = cloneGraph(graph);
  const cases = next.steps[id].cases!;
  const rebuilt: Record<string, string | null> = {};
  for (const [k, v] of Object.entries(cases)) rebuilt[k === from ? to : k] = v;
  next.steps[id].cases = rebuilt;
  return next;
}

export function addCase(graph: WorkflowGraph, id: string, value: string): WorkflowGraph {
  const step = graph.steps[id];
  if (!step || !value.trim()) return graph;
  const next = cloneGraph(graph);
  const target = next.steps[id];
  target.cases = { ...(target.cases ?? {}), [value.trim()]: null };
  if (target.default === undefined) target.default = null;
  return next;
}

export function removeCase(graph: WorkflowGraph, id: string, value: string): WorkflowGraph {
  const step = graph.steps[id];
  if (!step?.cases || !(value in step.cases)) return graph;
  const next = cloneGraph(graph);
  const cases = { ...next.steps[id].cases! };
  delete cases[value];
  next.steps[id].cases = cases;
  return pruneOrphans(next);
}

/** Point one edge somewhere else (used by the "then go to" selector). */
export function rewire(graph: WorkflowGraph, edge: EdgeRef, target: string | null): WorkflowGraph {
  const step = graph.steps[edge.from];
  if (!step) return graph;
  const next = cloneGraph(graph);
  setEdge(next.steps[edge.from], edge.slot, target);
  return pruneOrphans(next);
}

/** Rewrite every {{steps.<from>.…}} reference to point at a new step id. */
export function renameReferences(
  graph: WorkflowGraph,
  from: string,
  to: string,
): WorkflowGraph {
  const pattern = new RegExp(`\\{\\{\\s*steps\\.${from}\\.`, "g");
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(pattern, `{{steps.${to}.`);
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, rewrite(v)]),
      );
    }
    return value;
  };
  const next = cloneGraph(graph);
  for (const step of Object.values(next.steps)) {
    for (const [k, v] of configEntries(step)) step[k] = rewrite(v);
    if (step.from_step === from) step.from_step = to;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Data picker
// ---------------------------------------------------------------------------

export interface RefGroup {
  stepId: string;
  title: string;
  paths: { ref: string; label: string }[];
}

/**
 * Everything a step is allowed to reference: the outputs of every ancestor,
 * as ready-to-paste {{steps.…}} strings. Restricting to ancestors is what
 * keeps the editor from constructing a graph that validation would reject.
 */
export function availableRefs(graph: WorkflowGraph, stepId: string): RefGroup[] {
  const upstream = ancestors(graph, stepId);
  const order = orderedStepIds(graph);
  const groups: RefGroup[] = [];
  for (const id of order) {
    if (!upstream.has(id)) continue;
    const step = graph.steps[id];
    const paths = outputsOf(step);
    if (!paths.length) continue;
    groups.push({
      stepId: id,
      title: String(step.title ?? id),
      paths: step.type === "webhook_trigger"
        ? [
            { ref: "{{trigger}}", label: "Whole JSON payload" },
            ...(Array.isArray(step.sample_fields) ? step.sample_fields : []).map((field) => ({
              ref: `{{trigger.${String(field)}}}`,
              label: String(field),
            })),
          ]
        : paths.map((p) => ({ ref: `{{steps.${id}.${p.path}}}`, label: p.label })),
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Flow layout (what the canvas renders)
// ---------------------------------------------------------------------------

export interface FlowBranch {
  slot: EdgeSlot;
  label: string;
  items: FlowItem[];
}

export type FlowItem =
  | {
      kind: "step";
      id: string;
      step: StepDef;
      /** The edge this step hangs off — where a "+" above it inserts. */
      inbound: EdgeRef;
      /** Named sub-paths (branch cases, approve/reject), when it fans out. */
      branches?: FlowBranch[];
    }
  /** A path that rejoins a step already drawn above — drawn as a jump chip. */
  | { kind: "join"; targetId: string; title: string; inbound: EdgeRef }
  /** The open end of a path — where the trailing "+" adds a step. */
  | { kind: "end"; inbound: EdgeRef };

/**
 * Turn the graph into the tree the canvas draws: a spine of steps, with each
 * fan-out rendered as labelled, indented lanes. A path that converges back
 * onto an already-drawn step becomes a "join" chip rather than duplicating it,
 * so a diamond-shaped graph still renders as a finite tree.
 */
export function buildFlow(graph: WorkflowGraph): FlowItem[] {
  const drawn = new Set<string>();
  const spine = walk({ from: "", slot: "next" }, graph.start, graph, drawn);
  return spine;
}

function walk(
  inbound: EdgeRef,
  target: string | null,
  graph: WorkflowGraph,
  drawn: Set<string>,
): FlowItem[] {
  if (!target) return [{ kind: "end", inbound }];
  const step = graph.steps[target];
  if (!step) return [{ kind: "end", inbound }];
  if (drawn.has(target)) {
    return [{ kind: "join", targetId: target, title: String(step.title ?? target), inbound }];
  }
  drawn.add(target);

  const slots = edgeSlots(step);
  const fanOut = slots.length > 1;

  if (!fanOut) {
    const slot = slots[0] ?? "next";
    const item: FlowItem = { kind: "step", id: target, step, inbound };
    return [item, ...walk({ from: target, slot }, getEdge(step, slot), graph, drawn)];
  }

  const branches: FlowBranch[] = slots.map((slot) => ({
    slot,
    label: slotLabel(slot),
    items: walk({ from: target, slot }, getEdge(step, slot), graph, drawn),
  }));
  return [{ kind: "step", id: target, step, inbound, branches }];
}

export function slotLabel(slot: EdgeSlot): string {
  if (isCaseSlot(slot)) return caseValue(slot);
  switch (slot) {
    case "on_approve":
      return "Approved";
    case "on_reject":
      return "Rejected";
    case "on_fail":
      return "Doesn't match";
    case "default":
      return "Anything else";
    default:
      return "Then";
  }
}

/** Flat, execution-ordered list of steps — used by the compact list view. */
export function flatSteps(graph: WorkflowGraph): { id: string; step: StepDef }[] {
  return orderedStepIds(graph).map((id) => ({ id, step: graph.steps[id] }));
}
