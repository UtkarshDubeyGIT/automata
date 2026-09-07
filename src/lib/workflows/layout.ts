import { buildFlows, slotLabel, type FlowItem } from "./edit";
import type { EdgeRef, EdgeSlot } from "./graph";
import type { StepDef, WorkflowGraph } from "./types";

/**
 * Where every node of a workflow sits on the canvas — pure geometry, no React.
 *
 * The canvas is an infinite whiteboard, but the positions on it are DERIVED,
 * never stored: this module turns a graph into coordinates on every render, so
 * an AI edit, an undo or a hand edit can never leave a stale layout behind and
 * there is no second copy of the workflow's shape to disagree with the graph.
 *
 * It reads the same tree the old card canvas drew — `buildFlows()` already
 * resolves the spine, the labelled fan-out lanes, the open ends and the paths
 * that rejoin an earlier step — and only decides where each of those lands.
 *
 * `buildFlows()` returns the spine first and then one lane per run of steps
 * the trigger cannot reach; those stack below the spine, separated by a blank
 * row. Drawing them is not decoration: `draftIssues()` blocks publishing on
 * exactly those steps, so leaving them off the canvas left the error with
 * nothing to point at.
 *
 * The layout is a classic tidy tree running LEFT TO RIGHT: the spine advances
 * one column per step, a lane is a horizontal band, a fan-out splits its band
 * into one sub-band per path, and a parent sits centred beside everything its
 * paths occupy. Reading a workflow the way a sentence is read is what keeps a
 * long automation legible in a canvas that is much wider than it is tall.
 *
 * A node's box is the CIRCLE ONLY — its caption is drawn outside the box, so
 * arrows leave and enter the artwork itself rather than a bounding box with a
 * band of text in it.
 */

/** Box a step node occupies; the caption hangs below it, outside the box. */
export const NODE_W = 64;
export const NODE_H = 64;
/** Box an open-end marker occupies. */
export const END_W = 104;
export const END_H = 30;
/** The grid the tree is laid out on: a column per step, a row per lane. */
export const COL_W = 196;
export const ROW_H = 140;
/** Blank rows between the spine and each lane of trigger-less strays below it. */
export const STRAY_GAP_ROWS = 1;

export interface LaidOutNode {
  id: string;
  step: StepDef;
  /** Top-left of the node box, in flow coordinates. */
  x: number;
  y: number;
}

/** The open end of a path — where the trailing "+" hangs. */
export interface LaidOutEnd {
  id: string;
  x: number;
  y: number;
  /** The edge that dies here; a "+" on it appends to this path. */
  inbound: EdgeRef;
  /** True for the end of the workflow itself rather than of a branch path. */
  root: boolean;
}

export interface LaidOutEdge {
  id: string;
  from: string;
  /** A step id, or the id of the LaidOutEnd this path terminates at. */
  to: string;
  slot: EdgeSlot;
  /** The case name riding on the arrow — blank for a plain `next`. */
  label: string;
  /** `join` rejoins a step drawn earlier; `end` runs into an open-end marker. */
  kind: "flow" | "join" | "end";
}

export interface Layout {
  nodes: LaidOutNode[];
  ends: LaidOutEnd[];
  edges: LaidOutEdge[];
}

/** Stable id for the marker at the open end of one edge. */
export function endIdFor(edge: EdgeRef): string {
  return `end:${edge.from}:${edge.slot}`;
}

/** Stable id for one edge — a slot has exactly one target, so this is unique. */
export function edgeIdFor(edge: EdgeRef): string {
  return `edge:${edge.from}:${edge.slot}`;
}

export function layoutGraph(graph: WorkflowGraph): Layout {
  const out: Layout = { nodes: [], ends: [], edges: [] };
  let top = 0;
  for (const lane of buildFlows(graph)) {
    place(lane, top, 0, 0, out);
    // A blank row under each lane separates the spine from the stray lanes
    // below it, so "not part of the flow" reads as a gap rather than as
    // another branch of the same tree.
    top += measure(lane) + STRAY_GAP_ROWS;
  }
  return out;
}

/**
 * How many rows a lane needs.
 *
 * A lane is a run of linear steps that may END in a fan-out (`walk()` in
 * edit.ts stops a lane at the branching step), so its height is entirely
 * decided by that last item's paths.
 */
function measure(items: FlowItem[]): number {
  const last = items[items.length - 1];
  if (last?.kind === "step" && last.branches?.length) {
    return last.branches.reduce((sum, branch) => sum + measure(branch.items), 0);
  }
  return 1;
}

/**
 * Lay one lane out rightwards from column `col`, occupying `height` rows
 * starting at row `top`. Every item in the lane sits on the lane's centre
 * line; a fan-out hands each path its own slice of the same rows, which is
 * what keeps a parent centred beside its children.
 */
function place(items: FlowItem[], top: number, col: number, depth: number, out: Layout): void {
  const height = measure(items);
  const centre = (top + height / 2) * ROW_H;
  let c = col;

  for (const item of items) {
    if (item.kind === "end") {
      out.ends.push({
        id: endIdFor(item.inbound),
        x: c * COL_W,
        y: centre - END_H / 2,
        inbound: item.inbound,
        root: depth === 0,
      });
      pushEdge(out, item.inbound, endIdFor(item.inbound), "end");
      continue;
    }

    if (item.kind === "join") {
      pushEdge(out, item.inbound, item.targetId, "join");
      continue;
    }

    out.nodes.push({
      id: item.id,
      step: item.step,
      x: c * COL_W,
      y: centre - NODE_H / 2,
    });
    pushEdge(out, item.inbound, item.id, "flow");

    if (item.branches?.length) {
      let row = top;
      for (const branch of item.branches) {
        const span = measure(branch.items);
        place(branch.items, row, c + 1, depth + 1, out);
        row += span;
      }
    }
    c++;
  }
}

function pushEdge(out: Layout, inbound: EdgeRef, to: string, kind: LaidOutEdge["kind"]): void {
  // The spine's first step hangs off nothing — there is no edge into a trigger.
  if (!inbound.from) return;
  out.edges.push({
    id: edgeIdFor(inbound),
    from: inbound.from,
    to,
    slot: inbound.slot,
    label: inbound.slot === "next" ? "" : slotLabel(inbound.slot),
    kind,
  });
}

/**
 * Centre of one edge, for hit-testing a node dropped onto it. Arrows leave the
 * right of their source and enter the left of their target, so the midpoint of
 * those two handles is where the "+" and the drop target sit.
 */
export function edgeMidpoint(
  edge: LaidOutEdge,
  boxes: Map<string, { x: number; y: number; w: number; h: number }>,
): { x: number; y: number } | null {
  const from = boxes.get(edge.from);
  const to = boxes.get(edge.to);
  if (!from || !to) return null;
  return {
    x: (from.x + from.w + to.x) / 2,
    y: (from.y + from.h / 2 + (to.y + to.h / 2)) / 2,
  };
}
