"use client";

import "@xyflow/react/dist/style.css";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  NodeToolbar,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type FitViewOptions,
  type Node,
  type NodeProps,
  type XYPosition,
  type Viewport,
} from "@xyflow/react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { tileColors } from "@/lib/data/workflows";
import { toolkitLogo } from "@/lib/social/platforms";
import { describeStep, isTriggerType } from "@/lib/workflows/blocks";
import { ancestors, edgeSlots, type EdgeRef } from "@/lib/workflows/graph";
import {
  COL_W,
  END_H,
  END_W,
  NODE_H,
  NODE_W,
  ROW_H,
  layoutGraph,
} from "@/lib/workflows/layout";
import type { WorkflowPositions } from "@/lib/workflows/editor";
import type { StepDef, WorkflowGraph } from "@/lib/workflows/types";
import { WhatsAppNodeAlert } from "./whatsapp-node-status";

/**
 * The flow canvas — the visual half of the builder, as an infinite whiteboard.
 *
 * The graph reads LEFT TO RIGHT, one column per step (see
 * src/lib/workflows/layout.ts): every step is a circle you can read at a
 * glance — its app logo or type icon, a short name under it, and a ring that
 * says whether it's ready, selected, or how it fared in the last run.
 * Everything else — what it actually does, what it's still missing, and the
 * buttons that edit it — waits in a popover until you hover it, which is what
 * keeps a twenty-step automation legible.
 *
 * Module positions are editor state, deliberately separate from the executable
 * graph. A deterministic layout supplies positions for legacy workflows until
 * their first edit is saved.
 */

/**
 * How near an arrow a dragged step has to land to be spliced onto it. Kept
 * under half a column so a drag can't reach past the arrow it's aimed at into
 * the lane above or below.
 */
const DROP_RADIUS = 82;

/**
 * How the board frames itself, and the one place that decides it — the fit on
 * mount, after an edit, on a resize and from the toolbar button must agree or
 * the canvas jumps between two framings.
 *
 * Padding is in pixels per side rather than a fraction because a node's box is
 * only its circle: the caption is drawn outside the box React Flow measures, so
 * an even padding leaves the bottom row of labels clipped. `maxZoom: 1` stops a
 * two-step automation from being blown up to fill a wide canvas.
 */
const FIT_VIEW: FitViewOptions = {
  padding: { top: "40px", right: "56px", bottom: "78px", left: "56px" },
  maxZoom: 1,
};

export interface CanvasProps {
  graph: WorkflowGraph;
  positions: WorkflowPositions;
  selectedId: string | null;
  /** Step id → the things still missing before it can run. */
  gaps: Record<string, string[]>;
  /** Step id → the outcome of the most recent run, when one is being replayed. */
  runStatus?: Record<string, "done" | "failed">;
  /** True while a run is actually in flight — lights the whole graph up. */
  running?: boolean;
  onSelect: (id: string) => void;
  onInsert: (edge: EdgeRef) => void;
  onChangeTrigger: () => void;
  onMove: (id: string, dir: "up" | "down") => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onMoveNode: (id: string, position: XYPosition) => void;
  onDropBlock: (blockId: string, position: XYPosition, edge: EdgeRef | null) => void;
  /** Handle-to-node drag: point this slot at that step. */
  onRewire: (edge: EdgeRef, target: string | null) => void;
  canMove: (id: string, dir: "up" | "down") => boolean;
}

/* Nodes and edges are rendered by React Flow, which owns their props — the rest
   of the canvas reaches its callbacks and the live graph through context rather
   than through `data`, so a re-render doesn't have to rebuild every node. */
const CanvasCtx = createContext<CanvasProps | null>(null);
/**
 * Steps whose popover has to open upwards.
 *
 * A left-to-right graph is wide and shallow, so a panel beside a circle covers
 * the next step along; below is the free space — except for the bottom lane of
 * a fan-out, which has to open the other way.
 *
 * Kept in context so the placement calculation does not have to travel through
 * every React Flow node's serialised data.
 */
const FlipCtx = createContext<ReadonlySet<string>>(new Set());

function useCanvas(): CanvasProps {
  const value = useContext(CanvasCtx);
  if (!value) throw new Error("Canvas context is missing");
  return value;
}

export function Canvas(props: CanvasProps) {
  return (
    <CanvasCtx.Provider value={props}>
      <ReactFlowProvider>
        <Whiteboard />
      </ReactFlowProvider>
    </CanvasCtx.Provider>
  );
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const nodeTypes = { step: StepNode, endpoint: EndNode };
const edgeTypes = { flow: FlowEdge };

function Whiteboard() {
  const ctx = useCanvas();
  const { graph } = ctx;
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const { fitView, zoomIn, zoomOut, zoomTo, screenToFlowPosition, setViewport } = useReactFlow();

  const laidOut = useMemo<Node[]>(
    () => {
      const defaultNodes = new Map(layout.nodes.map((node) => [node.id, node]));
      return [
        ...layout.nodes.map((node) => ({
        id: node.id,
        type: "step",
        position: ctx.positions[node.id] ?? { x: node.x, y: node.y },
        data: {},
        // Only a plain single-`next` step can be dragged onto another arrow —
        // a fan-out dropped on one arrow gives no answer to which of ITS paths
        // continues from there, the same reason the move buttons hide.
        draggable: true,
      })),
        ...layout.ends.map((end) => {
          const sourceDefault = defaultNodes.get(end.inbound.from);
          const sourceActual = ctx.positions[end.inbound.from] ?? sourceDefault;
          const position = sourceDefault && sourceActual
            ? {
                x: sourceActual.x + (end.x - sourceDefault.x) * (260 / COL_W),
                y: sourceActual.y + (end.y - sourceDefault.y) * (170 / ROW_H),
              }
            : { x: end.x, y: end.y };
          return {
            id: end.id,
            type: "endpoint",
            position,
            data: { root: end.root },
            draggable: false,
            selectable: false,
          };
        }),
      ];
    },
    [layout, ctx.positions],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(laidOut);
  const [desktopAuthoring, setDesktopAuthoring] = useState(true);
  useEffect(() => setNodes(laidOut), [laidOut, setNodes]);
  const topology = useMemo(
    () => `${layout.nodes.map((node) => node.id).join("|")}::${layout.edges.map((edge) => edge.id + ":" + edge.to).join("|")}`,
    [layout],
  );
  const previousTopology = useRef(topology);
  useEffect(() => {
    if (previousTopology.current === topology) return;
    previousTopology.current = topology;
    const frame = window.requestAnimationFrame(() => void fitView({ ...FIT_VIEW, duration: 240 }));
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, topology]);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktopAuthoring(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  const edges = useMemo<Edge[]>(
    () =>
      layout.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        sourceHandle: edge.slot,
        targetHandle: "in",
        type: "flow",
        data: { slot: edge.slot, label: edge.label, kind: edge.kind },
        markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13 },
      })),
    [layout],
  );

  const nearestEdge = useCallback((point: XYPosition): EdgeRef | null => {
    let best: { edge: EdgeRef; distance: number } | null = null;
    for (const edge of layout.edges) {
      if (edge.kind === "join") continue;
      const source = nodes.find((node) => node.id === edge.from);
      const target = nodes.find((node) => node.id === edge.to);
      if (!source || !target) continue;
      const x = (source.position.x + NODE_W + target.position.x) / 2;
      const y = (source.position.y + NODE_H / 2 + target.position.y + NODE_H / 2) / 2;
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= DROP_RADIUS && (!best || distance < best.distance)) {
        best = { edge: { from: edge.from, slot: edge.slot }, distance };
      }
    }
    return best?.edge ?? null;
  }, [layout.edges, nodes]);

  /**
   * The overview only shows itself while you're zooming.
   *
   * A permanent minimap sits in the same corner a node's popover wants, and the
   * two ended up stacked on top of each other. Tying it to the gesture it
   * actually serves means the canvas is empty chrome the rest of the time.
   */
  const [overviewOn, setOverviewOn] = useState(false);
  const lastZoom = useRef<number | null>(null);
  const hideOverview = useRef<number | null>(null);
  const onMove = useCallback((_: unknown, viewport: Viewport) => {
    // The first move is the initial fitView, and panning isn't zooming.
    if (lastZoom.current === null || Math.abs(viewport.zoom - lastZoom.current) < 0.002) {
      lastZoom.current = viewport.zoom;
      return;
    }
    lastZoom.current = viewport.zoom;
    setOverviewOn(true);
    if (hideOverview.current) window.clearTimeout(hideOverview.current);
    hideOverview.current = window.setTimeout(() => setOverviewOn(false), 1400);
  }, []);
  useEffect(
    () => () => void (hideOverview.current && window.clearTimeout(hideOverview.current)),
    [],
  );

  useEffect(() => {
    try {
      const saved = localStorage.getItem("zidaneai:workflow-viewport");
      if (saved) void setViewport(JSON.parse(saved) as Viewport);
    } catch {
      // A malformed browser preference should never stop the editor opening.
    }
  }, [setViewport]);

  /** Nodes in the lower half open their popover upwards, into open space. */
  const flipUp = useMemo(() => {
    const ys = layout.nodes.map((node) => node.y);
    const middle = (Math.min(...ys) + Math.max(...ys)) / 2;
    return new Set(layout.nodes.filter((node) => node.y > middle).map((node) => node.id));
  }, [layout]);

  const board = useRef<HTMLDivElement | null>(null);

  /** A connection is legal when it lands on a real step and doesn't close a loop. */
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const { source, target, sourceHandle } = connection;
      if (!source || !target || !sourceHandle || source === target) return false;
      if (!graph.steps[target]) return false;
      return !ancestors(graph, source).has(target);
    },
    [graph],
  );

  return (
    <FlipCtx.Provider value={flipUp}>
        <ReactFlow
          ref={board}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => ctx.onSelect(node.id)}
          onNodeDragStop={(_, node) => {
            if (graph.steps[node.id]) ctx.onMoveNode(node.id, node.position);
          }}
          onConnect={(connection) => {
            if (!connection.source || !connection.target || !connection.sourceHandle) return;
            ctx.onRewire(
              { from: connection.source, slot: connection.sourceHandle },
              connection.target,
            );
          }}
          isValidConnection={isValidConnection}
          onMove={onMove}
          onMoveEnd={(_, viewport) => {
            try { localStorage.setItem("zidaneai:workflow-viewport", JSON.stringify(viewport)); } catch {}
          }}
          onEdgesDelete={(deleted) => deleted.forEach((edge) => {
            const slot = String(edge.sourceHandle ?? "next");
            ctx.onRewire({ from: edge.source, slot }, null);
          })}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("application/x-zidaneai-module")) event.preventDefault();
          }}
          onDrop={(event) => {
            const blockId = event.dataTransfer.getData("application/x-zidaneai-module");
            if (!blockId) return;
            event.preventDefault();
            const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
            ctx.onDropBlock(blockId, position, nearestEdge(position));
          }}
          fitView
          fitViewOptions={FIT_VIEW}
          minZoom={0.2}
          maxZoom={1.6}
          selectNodesOnDrag={false}
          nodesConnectable={desktopAuthoring}
          nodesDraggable={desktopAuthoring}
          panOnScroll={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: false }}
          className="rounded-card bg-inset"
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--color-line-strong)" />

          <MiniMap
            position="top-right"
            pannable
            zoomable
            ariaLabel="Workflow overview"
            nodeStrokeWidth={3}
            nodeColor={(node) => miniMapColor(node.id, ctx)}
            maskColor="color-mix(in oklab, var(--color-inset) 70%, transparent)"
            // Kept mounted so it can fade rather than pop, and click-through while
            // hidden so it never eats a gesture meant for the canvas.
            style={{ width: 156, height: 88 }}
            className={cn(
              "!m-2.5 !rounded-[9px] !border !border-line !bg-card transition-opacity duration-300",
              overviewOn ? "opacity-90" : "pointer-events-none opacity-0",
            )}
          />

          <Panel position="bottom-left" className="!m-3">
            <div className="flex items-center gap-0.5 rounded-full border border-line bg-card p-1 shadow-xs">
              <BoardButton icon="zoom-in" label="Zoom in" onClick={() => void zoomIn({ duration: 160 })} />
              <BoardButton icon="zoom-out" label="Zoom out" onClick={() => void zoomOut({ duration: 160 })} />
              <BoardButton icon="target" label="Reset zoom" onClick={() => void zoomTo(1, { duration: 200 })} />
              <BoardButton
                icon="maximize"
                label="Fit to view"
                onClick={() => void fitView({ ...FIT_VIEW, duration: 260 })}
              />
            </div>
          </Panel>
        </ReactFlow>
    </FlipCtx.Provider>
  );
}

function BoardButton({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex h-7 w-7 items-center justify-center rounded-full text-ink-subtle transition-colors hover:bg-inset hover:text-ink"
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

function StepNode({ id, dragging }: NodeProps) {
  const ctx = useCanvas();
  const flipUp = useContext(FlipCtx);
  const step = ctx.graph.steps[id];
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | null>(null);

  const show = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    setOpen(true);
  }, []);
  // A grace period, because the popover is a sibling in a portal: without it,
  // crossing the gap between the circle and its own popover closes it.
  const hide = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 220);
  }, []);
  useEffect(() => () => void (closeTimer.current && window.clearTimeout(closeTimer.current)), []);

  if (!step) return null;

  const described = describeStep(step);
  const trigger = isTriggerType(step.type);
  const selected = ctx.selectedId === id;
  const needsSetup = (ctx.gaps[id] ?? []).length > 0;
  const status = ctx.runStatus?.[id];
  const slots = edgeSlots(step);

  return (
    <div
      className="relative"
      style={{ width: NODE_W, height: NODE_H }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        className="!h-2 !w-2 !border-2 !border-card !bg-line-strong"
      />

      <div
        className={cn(
          "relative flex h-full w-full items-center justify-center rounded-full border-2 bg-card transition-all",
          selected
            ? "border-brand shadow-[0_0_0_4px_rgba(23,23,23,0.18)]"
            : status === "failed"
              ? "border-danger"
              : status === "done"
                ? "border-success"
                : needsSetup
                  ? "border-warning-border"
                  : "border-line",
          // An unfinished step steps back so the ready path is what reads first.
          needsSetup && !selected && "opacity-55 saturate-50",
        )}
      >
        <StepTile step={step} size={34} round />
        {(needsSetup || status) && (
          <span
            className={cn(
              "absolute -right-0.5 -top-0.5 flex h-[17px] w-[17px] items-center justify-center rounded-full border-2 border-card",
              status === "failed"
                ? "bg-danger text-white"
                : status === "done"
                  ? "bg-success text-white"
                  : "bg-warning text-white",
            )}
          >
            <Icon name={status === "failed" ? "x" : status === "done" ? "check" : "info"} size={9} />
          </span>
        )}
      </div>

      {/* The caption is drawn OUTSIDE the node box, so an arrow meets the
          circle itself rather than the edge of a block of text. It can't take
          a pointer either, or the words would swallow the drag on the circle
          in the lane below. */}
      <div className="pointer-events-none absolute left-1/2 top-full flex w-[152px] -translate-x-1/2 flex-col items-center pt-1.5">
        <span
          className={cn(
            "line-clamp-2 text-center text-[11.5px] font-medium leading-[1.28]",
            selected ? "text-ink" : "text-ink-muted",
          )}
        >
          {described.title}
        </span>
        {trigger && (
          <span className="mt-0.5 rounded-full bg-brand-subtle px-1.5 text-[9.5px] font-bold uppercase tracking-wide text-brand">
            Trigger
          </span>
        )}
        {step.type === "whatsapp_reminder" && (
          <WhatsAppNodeAlert onClick={() => ctx.onSelect(id)} />
        )}
      </div>

      {/* One source handle per routing slot, so a handle-to-node drag can only
          ever produce an edge the graph already has a name for. They stack down
          the right-hand edge, in the order the paths are drawn. */}
      {slots.map((slot, i) => (
        <Handle
          key={slot}
          type="source"
          id={slot}
          position={Position.Right}
          style={{ top: `${((i + 1) / (slots.length + 1)) * 100}%` }}
          className="!h-2 !w-2 !border-2 !border-card !bg-line-strong hover:!bg-brand"
        />
      ))}

      {/*
        One panel per step, never two.
        - Hidden mid-drag: a popover chasing the circle you're dragging covers
          the arrows you're trying to aim at.
        - Hidden while this step is the selected one: the inspector is already
          open beside the canvas saying the same thing, and the two overlapped.
        - Opens below the circle, clearing its caption, so it doesn't cover the
          step the arrow points at; the bottom lane opens upwards instead.
      */}
      <NodeToolbar
        nodeId={id}
        isVisible={open && !dragging && !selected}
        position={flipUp.has(id) ? Position.Top : Position.Bottom}
        offset={flipUp.has(id) ? 12 : 54}
        align="center"
      >
        <div
          onMouseEnter={show}
          onMouseLeave={hide}
          className="w-[250px] rounded-card border border-line bg-card p-3 text-left shadow-lg"
        >
          <div className="text-[13px] font-semibold leading-snug text-ink">{described.title}</div>
          {described.summary && (
            <div className="mt-0.5 text-[12px] leading-snug text-ink-subtle">{described.summary}</div>
          )}
          {needsSetup && (
            <ul className="mt-2 flex flex-col gap-1">
              {(ctx.gaps[id] ?? []).map((gap) => (
                <li key={gap} className="flex items-start gap-1.5 text-[11.5px] text-warning">
                  <Icon name="info" size={11} className="mt-[2px] flex-none" />
                  {gap}
                </li>
              ))}
            </ul>
          )}
          {/* The step id is what {{steps.<id>.…}} references, so it's worth showing. */}
          <div className="mt-2 font-mono text-[10px] text-ink-subtle">{id}</div>

          <div className="mt-2 flex items-center gap-0.5 border-t border-line pt-2">
            {trigger ? (
              <ToolbarButton icon="refresh" label="Change trigger" onClick={ctx.onChangeTrigger} />
            ) : (
              <>
                {/* "up"/"down" is the graph API's word for earlier/later in the
                    spine; on a board that reads left to right, the button has
                    to point the way the step actually moves. */}
                {ctx.canMove(id, "up") && (
                  <ToolbarButton
                    icon="chevron-left"
                    label="Move earlier"
                    onClick={() => ctx.onMove(id, "up")}
                  />
                )}
                {ctx.canMove(id, "down") && (
                  <ToolbarButton
                    icon="chevron-right"
                    label="Move later"
                    onClick={() => ctx.onMove(id, "down")}
                  />
                )}
                <ToolbarButton icon="copy" label="Duplicate" onClick={() => ctx.onDuplicate(id)} />
                <ToolbarButton icon="trash" label="Delete step" danger onClick={() => ctx.onDelete(id)} />
              </>
            )}
            <button
              onClick={() => ctx.onSelect(id)}
              className="ml-auto text-[11.5px] font-semibold text-brand hover:underline"
            >
              Open
            </button>
          </div>
        </div>
      </NodeToolbar>
    </div>
  );
}

function ToolbarButton({
  icon,
  label,
  onClick,
  danger,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-[7px] text-ink-subtle transition-colors hover:bg-inset",
        danger ? "hover:text-danger" : "hover:text-ink",
      )}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

/** The open end of a path — the "+" that appends to it lives on the arrow before it. */
function EndNode({ data }: NodeProps) {
  return (
    <div className="relative" style={{ width: END_W, height: END_H }}>
      <Handle
        type="target"
        id="in"
        position={Position.Left}
        isConnectable={false}
        className="!h-1.5 !w-1.5 !border-0 !bg-line-strong"
      />
      <span className="flex h-full w-full items-center justify-center rounded-full border border-dashed border-line px-2 text-[10.5px] text-ink-subtle">
        {data?.root ? "End of workflow" : "Path ends here"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------

function FlowEdge({
  id,
  source,
  sourceX,
  sourceY,
  sourcePosition,
  target,
  targetX,
  targetY,
  targetPosition,
  data,
  markerEnd,
}: EdgeProps) {
  const ctx = useCanvas();
  const reduced = usePrefersReducedMotion();

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const slot = String(data?.slot ?? "next");
  const label = String(data?.label ?? "");
  const kind = String(data?.kind ?? "flow");

  // "Live" means data really went this way: during a run with no per-step
  // detail yet, that's the whole graph; while replaying one, it's only the
  // arrows between steps the run actually reached.
  const status = ctx.runStatus;
  const live = status
    ? status[source] === "done" && (kind === "end" || status[target] === "done")
    : Boolean(ctx.running);

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke: live
              ? "var(--color-brand-border)"
              : "var(--color-line-strong)",
          strokeWidth: 1.6,
          strokeDasharray: kind === "join" ? "5 4" : undefined,
        }}
      />

      {/* The flow itself: dots riding the exact curve the edge drew. The global
          reduced-motion rule in globals.css only silences CSS animations, so
          SMIL has to be gated here by hand. */}
      {!reduced &&
        (live ? [0, -0.45, -0.9] : [0]).map((begin, i) => (
          <circle
            key={i}
            r={live ? 3 : 2.2}
            fill={live ? "var(--color-brand)" : "var(--color-line-strong)"}
            opacity={live ? 0.95 : 0.45}
          >
            <animateMotion
              dur={live ? "1.3s" : "4.2s"}
              begin={`${begin}s`}
              repeatCount="indefinite"
              path={path}
            />
          </circle>
        ))}

      <EdgeLabelRenderer>
        <div
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          className="nodrag nopan group pointer-events-auto absolute flex flex-col items-center gap-1 p-2"
        >
          {label && (
            <span className="rounded-full border border-line bg-card px-2 py-0.5 text-[10.5px] font-semibold text-ink-muted shadow-xs">
              {label}
            </span>
          )}
          <button
            onClick={() => ctx.onInsert({ from: source, slot })}
            aria-label="Add a step here"
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-full border bg-card shadow-xs transition-all",
              "border-line text-ink-muted opacity-0 hover:border-brand hover:text-brand focus:opacity-100 group-hover:opacity-100",
            )}
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function miniMapColor(id: string, ctx: CanvasProps): string {
  if (!ctx.graph.steps[id]) return "var(--color-line)";
  if (ctx.selectedId === id) return "var(--color-brand)";
  const status = ctx.runStatus?.[id];
  if (status === "failed") return "var(--color-danger)";
  if (status === "done") return "var(--color-success)";
  if ((ctx.gaps[id] ?? []).length) return "var(--color-warning)";
  return "var(--color-line-strong)";
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return reduced;
}

export function StepTile({
  step,
  size = 34,
  round = false,
}: {
  step: StepDef;
  size?: number;
  /** Circular art, for the canvas nodes; the inspector keeps the square tile. */
  round?: boolean;
}) {
  const described = describeStep(step);
  const tc = tileColors(described.tile);
  const [broken, setBroken] = useState(false);

  if (described.app && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={toolkitLogo(described.app)}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn(
          "flex-none object-contain",
          // On the canvas the node's own ring already frames the art, so a
          // second border around the logo just draws the circle twice.
          round ? "rounded-full" : "rounded-[9px] border border-line bg-card p-1",
        )}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cn("flex flex-none items-center justify-center", round ? "rounded-full" : "rounded-[9px]")}
      style={{ background: tc.bg, color: tc.fg, width: size, height: size }}
    >
      <Icon name={described.icon} size={Math.round(size * 0.52)} strokeWidth={1.9} />
    </span>
  );
}
