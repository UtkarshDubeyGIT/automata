"use client";

import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Connection,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  getBezierPath,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  ArrowLeft,
  Bot,
  Braces,
  Check,
  ChevronDown,
  Clock3,
  GitBranch,
  Globe2,
  ImageIcon,
  ListFilter,
  Loader2,
  LockKeyhole,
  Maximize,
  MoreHorizontal,
  MousePointer2,
  Play,
  Plus,
  Redo2,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  TriangleAlert,
  Trash2,
  Undo2,
  Webhook,
  X,
  Zap,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { INTEGRATION_BY_SLUG } from "@/lib/integrations/catalog";
import { ServiceIcon } from "@/components/service-icon";
import { TRIGGER_TYPES, type StepType, type WorkflowGraph, type WorkflowStep } from "@/lib/workflows/types";
import {
  arrangeGraph,
  connectSteps,
  diffWorkflowGraphs,
  draftIssues,
  initialCanvasPositions,
  positionsAfterGraphChange,
  removeStepDetached,
  upstreamVariables,
  type EditorEdgeRef,
  type WorkflowPositions,
} from "@/lib/workflows/editor";

import "@xyflow/react/dist/style.css";

type ModuleKind = "trigger" | "app" | "ai" | "approval" | "logic" | "http" | "image";
type ModuleNodeData = Record<string, unknown> & { step: WorkflowStep; kind: ModuleKind };
type ModuleFlowNode = Node<ModuleNodeData, "module">;

const starterGraph: WorkflowGraph = {
  start: "start",
  steps: { start: { id: "start", type: "manual_trigger", name: "Run manually", next: null } },
};

const demoGraph: WorkflowGraph = {
  start: "morning",
  steps: {
    morning: { id: "morning", type: "schedule_trigger", name: "Weekdays at 9:00", cron: "0 9 * * 1-5", next: "deals" },
    deals: { id: "deals", type: "app_action", name: "Read open deals", app: "hubspot", action: "HUBSPOT_LIST_DEALS", operation: "read", next: "summary" },
    summary: { id: "summary", type: "ai", name: "Write the daily digest", instruction: "Summarize movement, stalled deals, and next actions without inventing data.", next: "approve" },
    approve: { id: "approve", type: "approval", name: "Review pipeline digest", prompt: "Post this digest to Slack?", onApprove: "post", onReject: null, next: null },
    post: { id: "post", type: "app_action", name: "Post to #sales-daily", app: "slack", action: "SLACK_SEND_MESSAGE", operation: "write", next: null },
  },
};

const palette: Array<{ title: string; description: string; type: StepType; kind: ModuleKind; icon: typeof Zap }> = [
  { title: "App action", description: "Run a verified app action", type: "app_action", kind: "app", icon: Zap },
  { title: "HTTP request", description: "Call any JSON API", type: "http_request", kind: "http", icon: Globe2 },
  { title: "AI step", description: "Draft, extract, or classify", type: "ai", kind: "ai", icon: Bot },
  { title: "Generate image", description: "Create one image", type: "image", kind: "image", icon: ImageIcon },
  { title: "Filter", description: "Continue only when true", type: "filter", kind: "logic", icon: ListFilter },
  { title: "Router", description: "Choose a named path", type: "router", kind: "logic", icon: GitBranch },
  { title: "Transform data", description: "Map and format fields", type: "transform", kind: "logic", icon: Braces },
  { title: "Human approval", description: "Pause for a decision", type: "approval", kind: "approval", icon: ShieldCheck },
];

function kindForStep(step: WorkflowStep): ModuleKind {
  if (TRIGGER_TYPES.has(step.type)) return "trigger";
  if (step.type === "ai") return "ai";
  if (step.type === "image") return "image";
  if (step.type === "approval") return "approval";
  if (step.type === "http_request") return "http";
  if (step.type === "app_action") return "app";
  return "logic";
}

function routeEdges(step: WorkflowStep): Array<{ slot: EditorEdgeRef["slot"]; target: string; label: string }> {
  const result: Array<{ slot: EditorEdgeRef["slot"]; target: string; label: string }> = [];
  if (step.next) result.push({ slot: "next", target: step.next, label: step.type === "filter" ? "Yes" : "" });
  if (step.onFalse) result.push({ slot: "onFalse", target: step.onFalse, label: "No" });
  if (step.onApprove) result.push({ slot: "onApprove", target: step.onApprove, label: "Approved" });
  if (step.onReject) result.push({ slot: "onReject", target: step.onReject, label: "Rejected" });
  for (const [name, target] of Object.entries(step.cases ?? {})) if (target) result.push({ slot: `case:${name}`, target, label: name });
  return result;
}

function makeFlow(graph: WorkflowGraph, positions: WorkflowPositions) {
  const nodes: ModuleFlowNode[] = [];
  for (const [id, step] of Object.entries(graph.steps)) nodes.push({ id, type: "module", position: positions[id] ?? { x: 96, y: 120 }, data: { step, kind: kindForStep(step) }, draggable: true });
  const edges: Edge[] = Object.values(graph.steps).flatMap((step) => routeEdges(step).map((route) => ({
    id: `${step.id}:${route.slot}`,
    source: step.id,
    target: route.target,
    sourceHandle: route.slot,
    targetHandle: "in",
    type: "flow",
    data: { label: route.label, from: step.id, slot: route.slot },
    markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: "#cbcdd9" },
  })));
  return { nodes, edges };
}

const nodeTypes = { module: ModuleNode };
const edgeTypes = { flow: FlowEdge };

type DraftSnapshot = { graph: WorkflowGraph; positions: WorkflowPositions };

export function WorkflowBuilder({ isNew = false, workflowId, workflowName, initialGraph, initialPositions, initialRevision = 0, publishedGraph, initiallyPublished }: { isNew?: boolean; workflowId?: string; workflowName?: string; initialGraph?: WorkflowGraph; initialPositions?: WorkflowPositions; initialRevision?: number; publishedGraph?: WorkflowGraph; initiallyPublished?: boolean }) {
  const router = useRouter();
  const firstGraph = initialGraph ?? (isNew ? starterGraph : demoGraph);
  const [graph, setGraph] = useState(firstGraph);
  const [positions, setPositions] = useState<WorkflowPositions>(() => initialCanvasPositions(firstGraph, initialPositions ?? {}));
  const [name, setName] = useState(workflowName ?? (isNew ? "Untitled automation" : "Daily pipeline digest"));
  const [selectedId, setSelectedId] = useState<string | null>(isNew ? "start" : "summary");
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [published, setPublished] = useState(initiallyPublished ?? !isNew);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(initialRevision);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "offline" | "conflict">("saved");
  const [history, setHistory] = useState<DraftSnapshot[]>([]);
  const [future, setFuture] = useState<DraftSnapshot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [triggerJson, setTriggerJson] = useState('{\n  "source": "manual",\n  "requested_at": "2026-08-31T09:00:00+05:30"\n}');
  const [aiPrompt, setAiPrompt] = useState("");
  const [libraryQuery, setLibraryQuery] = useState("");
  const saveTimer = useRef<number | null>(null);
  const flow = useMemo(() => makeFlow(graph, positions), [graph, positions]);
  const selected = selectedId ? graph.steps[selectedId] : null;
  const filteredPalette = palette.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(libraryQuery.toLowerCase()));
  const issues = useMemo(() => draftIssues(graph), [graph]);
  const variables = useMemo(() => selectedId ? upstreamVariables(graph, selectedId) : [], [graph, selectedId]);

  function checkpoint() {
    setHistory((items) => [...items.slice(-49), { graph, positions }]);
    setFuture([]);
  }

  function updateGraph(next: WorkflowGraph) {
    if (next === graph) return;
    checkpoint();
    setPositions((current) => positionsAfterGraphChange(graph, next, current));
    setGraph(next);
    setDirty(true);
  }

  function updatePositions(next: WorkflowPositions, remember = true) {
    if (remember) checkpoint();
    setPositions(next);
    setDirty(true);
  }

  function undo() {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((items) => [{ graph, positions }, ...items].slice(0, 50));
    setHistory((items) => items.slice(0, -1));
    setGraph(previous.graph); setPositions(previous.positions); setDirty(true);
  }

  function redo() {
    const next = future[0];
    if (!next) return;
    setHistory((items) => [...items, { graph, positions }].slice(-50));
    setFuture((items) => items.slice(1));
    setGraph(next.graph); setPositions(next.positions); setDirty(true);
  }

  async function save(silent = false) {
    if (busy) return;
    setBusy("save"); setSaveState("saving"); if (!silent) setNotice("");
    try {
      if (isNew || !workflowId || workflowId === "new") {
        const response = await fetch("/api/workflows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, graph, positions }) });
        const body = await response.json() as { workflow?: { id: string }; error?: string };
        if (!response.ok || !body.workflow) throw new Error(body.error ?? "Workflow could not be saved.");
        router.push(`/app/workflows/${body.workflow.id}`);
        return;
      }
      const response = await fetch(`/api/workflows/${workflowId}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, graph, positions, baseRevision: revision }) });
      const body = await response.json() as { error?: string; code?: string; revision?: number };
      if (response.status === 409 && body.code === "revision_conflict") {
        setSaveState("conflict"); setNotice("Someone else saved a newer draft. Reload this page or save your work as a copy."); return;
      }
      if (!response.ok) throw new Error(body.error ?? "Workflow could not be saved.");
      setRevision(body.revision ?? revision + 1); setDirty(false); setSaveState("saved"); if (!silent) setNotice("Draft saved.");
    } catch (error) { setSaveState("offline"); setNotice(error instanceof Error ? error.message : "Workflow could not be saved."); }
    finally { setBusy(null); }
  }

  async function saveAsCopy() {
    if (!workflowId || workflowId === "new") return;
    setBusy("copy");
    try {
      const response = await fetch(`/api/workflows/${workflowId}/copy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph, positions, name }) });
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "The copy could not be saved.");
      router.push(`/app/workflows/${body.id}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "The copy could not be saved."); setBusy(null); }
  }

  useEffect(() => {
    if (!dirty || isNew || !workflowId || saveState === "conflict") return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void save(true), 1000);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
    // Save is deliberately coalesced from the current draft values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, positions, name, dirty, workflowId, isNew, saveState]);

  async function publish() {
    if (!workflowId || workflowId === "new") { setNotice("Save this workflow before publishing it."); return; }
    if (dirty) { setNotice("Save your draft before publishing it."); return; }
    setBusy("publish"); setNotice("");
    try {
      const response = await fetch(`/api/workflows/${workflowId}/publish`, { method: "POST" });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Workflow could not be published.");
      setPublished(true); setNotice("Published. New triggers now use this version.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Workflow could not be published."); }
    finally { setBusy(null); }
  }

  async function runOnce() {
    if (!workflowId || workflowId === "new") { setNotice("Save this workflow before running it."); setRunOpen(false); return; }
    let triggerData: unknown;
    try { triggerData = JSON.parse(triggerJson); } catch { setNotice("Trigger data must be valid JSON."); return; }
    setBusy("run"); setNotice("Running against live services…");
    try {
      const response = await fetch(`/api/workflows/${workflowId}/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ triggerData }) });
      const body = await response.json() as { error?: string; run?: { state?: string; status?: string } };
      if (!response.ok) throw new Error(body.error ?? "Run failed.");
      const state = body.run?.state ?? body.run?.status ?? "completed";
      setNotice(state === "waiting_approval" ? "Paused safely. The live action is waiting for approval." : `Run ${state}.`);
      setRunOpen(false);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Run failed."); }
    finally { setBusy(null); }
  }

  async function askAutomata() {
    if (!aiPrompt.trim() || busy) return;
    setBusy("ai"); setNotice("Designing the updated workflow…");
    try {
      const context = Object.values(graph.steps).map((step) => step.name).join(" → ");
      const response = await fetch("/api/workflows/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: `${isNew ? "Build" : "Update"} this workflow. Current flow: ${context}. Request: ${aiPrompt}` }) });
      const body = await response.json() as { graph?: WorkflowGraph; error?: string };
      if (!response.ok || !body.graph) throw new Error(body.error ?? "Automata could not apply that change.");
      updateGraph(body.graph);
      setSelectedId(null); setAiPrompt(""); setNotice("The new draft is on the canvas. Review it, then save.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Automata could not apply that change."); }
    finally { setBusy(null); }
  }

  function addStep(item: (typeof palette)[number], at?: { x: number; y: number }, connectAfter = true, splice?: EditorEdgeRef) {
    const stem = item.type.replaceAll("_", "-");
    let suffix = Object.keys(graph.steps).length + 1;
    while (graph.steps[`${stem}-${suffix}`]) suffix += 1;
    const id = `${stem}-${suffix}`;
    const after = splice?.from ?? (selectedId && graph.steps[selectedId] ? selectedId : graph.start);
    const previous = graph.steps[after];
    const route = splice ? routeEdges(previous).find((edge) => edge.slot === splice.slot) : null;
    const downstream = splice ? route?.target ?? null : connectAfter ? previous.next ?? null : null;
    const newStep: WorkflowStep = { id, type: item.type, name: item.title, next: downstream };
    if (item.type === "ai") newStep.instruction = "Describe what this step should produce.";
    if (item.type === "approval") { newStep.prompt = "Continue this run?"; newStep.onApprove = downstream; newStep.onReject = null; newStep.next = null; }
    const steps = { ...graph.steps, [id]: newStep };
    if (splice) {
      const retargeted = connectSteps({ ...graph, steps }, splice, id);
      Object.assign(steps, retargeted.steps);
    } else if (connectAfter) steps[after] = { ...previous, next: id };
    const nextGraph = { ...graph, steps };
    checkpoint();
    setGraph(nextGraph);
    setPositions((current) => {
      const arranged = positionsAfterGraphChange(graph, nextGraph, current);
      return at && !connectAfter && !splice ? { ...arranged, [id]: at } : arranged;
    });
    setDirty(true);
    setSelectedId(id); setLibraryOpen(false);
  }

  function patchSelected(patch: Partial<WorkflowStep>) {
    if (!selected) return;
    updateGraph({ ...graph, steps: { ...graph.steps, [selected.id]: { ...selected, ...patch } } });
  }

  function deleteSelected() {
    if (!selected || selected.id === graph.start) return;
    const next = removeStepDetached(graph, selected.id);
    checkpoint();
    setGraph(next);
    setPositions((current) => positionsAfterGraphChange(graph, next, current));
    setDirty(true); setSelectedId(null);
  }

  function changeTrigger(type: "webhook_trigger" | "manual_trigger", title: string) {
    const current = graph.steps[graph.start];
    updateGraph({ ...graph, steps: { ...graph.steps, [graph.start]: { id: current.id, type, name: title, next: current.next ?? null } } });
    setSelectedId(graph.start); setLibraryOpen(false);
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(false); return; }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && !typing) {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y" && !typing) { event.preventDefault(); redo(); return; }
      if ((event.key === "Backspace" || event.key === "Delete") && !typing && selectedId && selectedId !== graph.start) { event.preventDefault(); deleteSelected(); }
      if (event.key === "Escape") { setSelectedId(null); setLibraryOpen(false); setPublishOpen(false); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // Handlers intentionally read the latest render's editor state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, positions, selectedId, history, future, revision, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const publishDiff = useMemo(() => diffWorkflowGraphs(publishedGraph ?? firstGraph, graph), [publishedGraph, firstGraph, graph]);

  return <div className="builder-shell growth-editor">
    <header className="growth-editor-header">
      <div className="growth-editor-title"><Link href="/app/workflows" aria-label="Back to automations"><ArrowLeft size={17} /></Link><span className="editor-app-mark"><Zap size={16} /></span><div><input value={name} onChange={(event) => { setName(event.target.value); setDirty(true); }} aria-label="Workflow name" /><small><i className={published ? "live" : ""} />{published ? "Live" : "Draft"}{dirty ? " · Unsaved changes" : " · All changes saved"}</small></div></div>
      <div className="growth-editor-actions"><button className="editor-icon-button" aria-label="Undo" onClick={undo} disabled={!history.length}><Undo2 size={15} /></button><button className="editor-icon-button" aria-label="Redo" onClick={redo} disabled={!future.length}><Redo2 size={15} /></button><button className={`editor-ai-toggle ${aiOpen ? "active" : ""}`} onClick={() => setAiOpen((value) => !value)}><Sparkles size={15} />Ask Automata</button><button className="editor-save" onClick={() => void save(false)} disabled={busy !== null || saveState === "conflict"}>{busy === "save" ? <Loader2 className="spin" size={15} /> : <Save size={15} />}{saveState === "conflict" ? "Conflict" : saveState === "offline" ? "Retry save" : dirty ? "Save" : "Saved"}</button><button className="editor-run" onClick={() => { setNotice(""); setRunOpen(true); }}><Play size={14} fill="currentColor" />Run once</button><button className="editor-publish" onClick={() => setPublishOpen(true)} disabled={busy !== null}>{busy === "publish" ? <Loader2 className="spin" size={14} /> : published ? <Check size={14} /> : null}{published ? "Publish changes" : "Publish"}<ChevronDown size={13} /></button><button className="editor-icon-button" aria-label="More actions"><MoreHorizontal size={16} /></button></div>
    </header>

    {notice ? <div className="editor-notice" role="status"><span>{notice}</span>{saveState === "conflict" ? <><button onClick={() => window.location.reload()}>Reload</button><button onClick={() => void saveAsCopy()}>Save as copy</button></> : null}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={13} /></button></div> : null}

    <div className="growth-editor-body">
      {aiOpen ? <aside className="editor-ai-panel"><header><div><span><Sparkles size={15} /></span><div><b>Ask Automata</b><small>Change this workflow in plain English</small></div></div><button onClick={() => setAiOpen(false)} aria-label="Close assistant"><X size={15} /></button></header><div className="editor-ai-empty"><span><Sparkles size={20} /></span><h2>What should change?</h2><p>Describe the outcome. Automata will preserve your layout and place new modules nearby.</p></div><div className="editor-ai-prompts"><button onClick={() => setAiPrompt("Add a human approval before the final external action")}>Add approval before publishing</button><button onClick={() => setAiPrompt("Send failures to Slack with the error details")}>Alert Slack when it fails</button></div><div className="editor-ai-composer"><textarea rows={4} value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="Add a filter after the HubSpot step…" /><button disabled={!aiPrompt.trim() || busy !== null} onClick={() => void askAutomata()}>{busy === "ai" ? <Loader2 className="spin" size={15} /> : <ArrowRightIcon />}</button></div></aside> : <ModuleLibrary query={libraryQuery} onQuery={setLibraryQuery} items={filteredPalette} onAdd={(item) => addStep(item)} />}

      <main className="workflow-canvas growth-canvas" data-testid="workflow-canvas">
        <ReactFlowProvider><WorkflowWhiteboard nodes={flow.nodes} edges={flow.edges} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setLibraryOpen(false); }} onMoveNode={(id, position) => updatePositions({ ...positions, [id]: position })} onConnect={(edge, target) => updateGraph(connectSteps(graph, edge, target))} onDropModule={(type, position, edge) => { const item = palette.find((entry) => entry.type === type); if (item) addStep(item, position, false, edge ?? undefined); }} onArrange={() => updatePositions(arrangeGraph(graph))} /></ReactFlowProvider>
        <div className="canvas-add-wrap"><button className="canvas-add-button" onClick={() => setLibraryOpen((value) => !value)}><Plus size={16} />Add step</button>{libraryOpen ? <div className="canvas-step-library"><header><b>Add a step</b><button onClick={() => setLibraryOpen(false)}><X size={14} /></button></header><label><Search size={14} /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search steps" /></label><div>{filteredPalette.map((item) => <button onClick={() => addStep(item)} key={item.type}><i className={`tile-${item.kind}`}><item.icon size={16} /></i><span><b>{item.title}</b><small>{item.description}</small></span></button>)}</div><footer title="Replace the current trigger"><button onClick={() => changeTrigger("webhook_trigger", "Webhook received")}><Webhook size={14} />Webhook trigger</button><button onClick={() => changeTrigger("manual_trigger", "Run manually")}><MousePointer2 size={14} />Manual</button></footer></div> : null}</div>
        <div className="canvas-legend"><span><i />Data moves left to right</span><b>{Object.keys(graph.steps).length} steps · estimated {Math.max(1, Object.keys(graph.steps).length - 1)} credits</b></div>
      </main>

      {selected ? <Inspector step={selected} isStart={selected.id === graph.start} variables={variables} onPatch={patchSelected} onDelete={deleteSelected} onClose={() => setSelectedId(null)} /> : null}
    </div>

    {issues.length ? <section className="canvas-issues" aria-label="Workflow issues"><header><span><TriangleAlert size={14} />{issues.length} issue{issues.length === 1 ? "" : "s"} before publishing</span></header>{issues.map((issue, index) => <button key={`${issue.code}-${index}`} onClick={() => issue.stepId && setSelectedId(issue.stepId)}>{issue.message}</button>)}</section> : null}

    {runOpen ? <RunDialog busy={busy === "run"} triggerJson={triggerJson} onTriggerJson={setTriggerJson} onClose={() => !busy && setRunOpen(false)} onRun={() => void runOnce()} /> : null}
    {publishOpen ? <PublishDialog diff={publishDiff} issues={issues.map((issue) => issue.message)} busy={busy === "publish"} onClose={() => setPublishOpen(false)} onPublish={() => { setPublishOpen(false); void publish(); }} /> : null}
  </div>;
}

function ModuleLibrary({ query, onQuery, items, onAdd }: { query: string; onQuery: (value: string) => void; items: typeof palette; onAdd: (item: (typeof palette)[number]) => void }) {
  return <aside className="editor-module-panel" aria-label="Module library"><header><div><b>Modules</b><small>Drag onto the canvas or add after the selected step</small></div></header><label className="module-search"><Search size={14} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder="Search modules" /></label><div className="module-list">{items.map((item) => <button draggable onDragStart={(event) => { event.dataTransfer.setData("application/x-automata-module", item.type); event.dataTransfer.effectAllowed = "copy"; }} onClick={() => onAdd(item)} key={item.type}><i className={`tile-${item.kind}`}><item.icon size={16} /></i><span><b>{item.title}</b><small>{item.description}</small></span><Plus size={14} /></button>)}</div><footer><span>Drag to place freely</span><small>Click to add after selection</small></footer></aside>;
}

function PublishDialog({ diff, issues, busy, onClose, onPublish }: { diff: ReturnType<typeof diffWorkflowGraphs>; issues: string[]; busy: boolean; onClose: () => void; onPublish: () => void }) {
  const count = diff.added.length + diff.removed.length + diff.changed.length;
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="run-modal publish-review" role="dialog" aria-modal="true" aria-labelledby="publish-title"><header><div><span>Publish review</span><h2 id="publish-title">Put this draft live?</h2></div><button onClick={onClose} aria-label="Close"><X size={18} /></button></header>{issues.length ? <div className="publish-blocked"><TriangleAlert size={16} /><div><b>Finish setup before publishing</b>{issues.map((issue) => <p key={issue}>{issue}</p>)}</div></div> : <><p>Future schedules, webhooks, and app events will use this version. Current runs keep their original version.</p><div className="publish-diff"><div><b>{diff.added.length}</b><span>Added</span></div><div><b>{diff.changed.length}</b><span>Changed</span></div><div><b>{diff.removed.length}</b><span>Removed</span></div></div>{count ? <ul>{[...diff.added.map((name) => `Added ${name}`), ...diff.changed.map((name) => `Changed ${name}`), ...diff.removed.map((name) => `Removed ${name}`)].slice(0, 8).map((line) => <li key={line}>{line}</li>)}</ul> : <p>No module changes were detected.</p>}</>}<footer><button onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy || Boolean(issues.length)} onClick={onPublish}>{busy ? "Publishing…" : "Publish draft"}</button></footer></section></div>;
}

function WorkflowWhiteboard({ nodes: initialNodes, edges: initialEdges, selectedId, onSelect, onMoveNode, onConnect, onDropModule, onArrange }: { nodes: ModuleFlowNode[]; edges: Edge[]; selectedId: string | null; onSelect: (id: string) => void; onMoveNode: (id: string, position: { x: number; y: number }) => void; onConnect: (edge: EditorEdgeRef, target: string | null) => void; onDropModule: (type: StepType, position: { x: number; y: number }, edge: EditorEdgeRef | null) => void; onArrange: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);
  const { fitView, zoomIn, zoomOut, screenToFlowPosition, setViewport, getViewport } = useReactFlow();
  const mounted = useRef(false);
  const topology = useMemo(() => `${initialNodes.map((node) => node.id).join("|")}::${initialEdges.map((edge) => edge.id + ":" + edge.target).join("|")}`, [initialNodes, initialEdges]);
  const previousTopology = useRef(topology);
  useEffect(() => {
    setNodes(initialNodes); setEdges(initialEdges);
    if (!mounted.current) {
      mounted.current = true;
      const stored = window.localStorage.getItem("automata:workflow-viewport");
      if (stored) { try { void setViewport(JSON.parse(stored), { duration: 0 }); return; } catch { /* fit below */ } }
      window.setTimeout(() => void fitView({ padding: .22, minZoom: .45, maxZoom: 1, duration: 220 }), 20);
    }
  }, [initialNodes, initialEdges, setNodes, setEdges, fitView, setViewport]);
  useEffect(() => {
    if (previousTopology.current === topology) return;
    previousTopology.current = topology;
    const frame = window.requestAnimationFrame(() => void fitView({ padding: .22, minZoom: .45, maxZoom: 1, duration: 240 }));
    return () => window.cancelAnimationFrame(frame);
  }, [fitView, topology]);
  const validConnection = useCallback((connection: Connection | Edge) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return false;
    const slot = (connection.sourceHandle ?? "next") as EditorEdgeRef["slot"];
    const currentGraph: WorkflowGraph = { start: initialNodes.find((node) => TRIGGER_TYPES.has(node.data.step.type))?.id ?? "", steps: Object.fromEntries(initialNodes.map((node) => [node.id, node.data.step])) };
    return connectSteps(currentGraph, { from: connection.source, slot }, connection.target) !== currentGraph;
  }, [initialNodes]);
  return <ReactFlow nodes={nodes.map((node) => ({ ...node, selected: node.id === selectedId }))} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onNodeClick={(_, node) => onSelect(node.id)} onNodeDragStop={(_, node) => onMoveNode(node.id, { x: Math.round(node.position.x / 20) * 20, y: Math.round(node.position.y / 20) * 20 })} onConnect={(connection) => connection.source && connection.target && onConnect({ from: connection.source, slot: (connection.sourceHandle ?? "next") as EditorEdgeRef["slot"] }, connection.target)} isValidConnection={validConnection} onEdgesDelete={(deleted) => deleted.forEach((edge) => { const data = edge.data as { from?: string; slot?: EditorEdgeRef["slot"] } | undefined; if (data?.from && data.slot) onConnect({ from: data.from, slot: data.slot }, null); })} onDrop={(event) => {
    event.preventDefault();
    const type = event.dataTransfer.getData("application/x-automata-module") as StepType;
    if (!type) return;
    const point = screenToFlowPosition({ x: event.clientX, y: event.clientY }, { snapToGrid: true });
    let nearest: { ref: EditorEdgeRef; distance: number } | null = null;
    for (const edge of edges) {
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      const data = edge.data as { from?: string; slot?: EditorEdgeRef["slot"] } | undefined;
      if (!source || !target || !data?.from || !data.slot) continue;
      const distance = Math.hypot(point.x - (source.position.x + target.position.x) / 2, point.y - (source.position.y + target.position.y) / 2);
      if (distance <= 90 && (!nearest || distance < nearest.distance)) nearest = { ref: { from: data.from, slot: data.slot }, distance };
    }
    onDropModule(type, point, nearest?.ref ?? null);
  }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }} onMoveEnd={() => window.localStorage.setItem("automata:workflow-viewport", JSON.stringify(getViewport()))} snapToGrid snapGrid={[20, 20]} fitView fitViewOptions={{ padding: .22, minZoom: .45, maxZoom: 1 }} minZoom={.25} maxZoom={1.6} nodesConnectable edgesReconnectable deleteKeyCode={["Backspace", "Delete"]} proOptions={{ hideAttribution: false }}>
    <Background variant={BackgroundVariant.Dots} gap={22} size={1.35} color="#cbcdd9" />
    <MiniMap pannable zoomable ariaLabel="Workflow overview" />
    <Panel position="bottom-left" className="canvas-controls-new"><button onClick={() => void zoomIn({ duration: 150 })} aria-label="Zoom in"><ZoomIn size={14} /></button><button onClick={() => void zoomOut({ duration: 150 })} aria-label="Zoom out"><ZoomOut size={14} /></button><button onClick={() => void fitView({ padding: .22, minZoom: .45, maxZoom: 1, duration: 240 })} aria-label="Fit to view"><Maximize size={14} /></button><button onClick={onArrange} aria-label="Arrange modules"><Braces size={14} /></button></Panel>
  </ReactFlow>;
}

function ModuleNode({ data, selected }: NodeProps<ModuleFlowNode>) {
  const step = data.step;
  const outputs: Array<{ id: EditorEdgeRef["slot"]; label?: string }> = step.type === "approval"
    ? [{ id: "onApprove", label: "Approve" }, { id: "onReject", label: "Reject" }]
    : step.type === "filter"
      ? [{ id: "next", label: "Yes" }, { id: "onFalse", label: "No" }]
      : step.type === "router"
        ? [...Object.keys(step.cases ?? {}).map((name) => ({ id: `case:${name}` as const, label: name })), { id: "next", label: "Default" }]
        : [{ id: "next" }];
  return <div className="growth-node-wrap">
    {!TRIGGER_TYPES.has(step.type) ? <Handle id="in" type="target" position={Position.Left} className="growth-node-handle" /> : null}
    <div className={`growth-node node-${data.kind} ${selected ? "selected" : ""}`}><StepArt step={step} kind={data.kind} />{TRIGGER_TYPES.has(step.type) ? <span className="growth-node-badge"><Zap size={8} /></span> : null}</div>
    <div className="growth-node-caption"><b>{step.name}</b>{TRIGGER_TYPES.has(step.type) ? <small>Trigger</small> : step.app ? <small>{INTEGRATION_BY_SLUG.get(step.app)?.name ?? step.app}</small> : null}</div>
    {outputs.map((output, index) => <Handle id={output.id} key={output.id} type="source" position={Position.Right} className="growth-node-handle" style={{ top: `${((index + 1) / (outputs.length + 1)) * 100}%` }} title={output.label} />)}
  </div>;
}

function StepArt({ step, kind }: { step: WorkflowStep; kind: ModuleKind }) {
  if (step.app) { const app = INTEGRATION_BY_SLUG.get(step.app); return <ServiceIcon className="growth-app-art" slug={step.app} label={app?.name ?? step.app} />; }
  const Icon = kind === "trigger" ? Clock3 : kind === "ai" ? Sparkles : kind === "approval" ? ShieldCheck : kind === "http" ? Globe2 : kind === "image" ? ImageIcon : GitBranch;
  return <span className="growth-step-art"><Icon size={26} /></span>;
}

function FlowEdge(props: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath(props);
  const label = String(props.data?.label ?? "");
  return <><BaseEdge path={path} markerEnd={props.markerEnd} style={{ stroke: "#cbcdd9", strokeWidth: 1.7 }} /><circle r="2.4" fill="#5e5ae0" opacity=".72"><animateMotion dur="3.6s" repeatCount="indefinite" path={path} /></circle>{label ? <EdgeLabelRenderer><span className="growth-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{label}</span></EdgeLabelRenderer> : null}</>;
}

function Inspector({ step, isStart, variables, onPatch, onDelete, onClose }: { step: WorkflowStep; isStart: boolean; variables: ReturnType<typeof upstreamVariables>; onPatch: (patch: Partial<WorkflowStep>) => void; onDelete: () => void; onClose: () => void }) {
  const kind = kindForStep(step);
  const insertVariable = (expression: string) => {
    if (kind === "ai") onPatch({ instruction: `${String(step.instruction ?? "")}${step.instruction ? " " : ""}${expression}` });
    else if (kind === "approval") onPatch({ prompt: `${String(step.prompt ?? "")}${step.prompt ? " " : ""}${expression}` });
    else onPatch({ input: expression });
  };
  return <aside className="growth-inspector"><header><div><small>{step.app ? INTEGRATION_BY_SLUG.get(step.app)?.name ?? step.app : kind === "trigger" ? "Trigger" : kind}</small><h2>{step.name}</h2></div><button onClick={onClose} aria-label="Close inspector"><X size={15} /></button></header><div className="growth-inspector-summary"><StepArt step={step} kind={kind} /><span><b>{step.app ? "Connected account" : step.type.replaceAll("_", " ")}</b><small>{step.operation === "write" ? "External write · approval protected" : step.app ? "Connected workspace" : "Built into Automata"}</small></span></div><div className="growth-inspector-section"><span>Configuration</span><label>Step name<input value={step.name} onChange={(event) => onPatch({ name: event.target.value })} /></label>{kind === "ai" ? <><label>Instruction<textarea rows={7} value={String(step.instruction ?? "")} onChange={(event) => onPatch({ instruction: event.target.value })} /></label><label>Output<select value={String(step.output ?? "text")} onChange={(event) => onPatch({ output: event.target.value })}><option value="json">Structured data</option><option value="text">Plain text</option></select></label></> : kind === "trigger" ? <><label>Schedule or event<input value={String(step.cron ?? step.event ?? "On demand")} onChange={(event) => onPatch(step.type === "schedule_trigger" ? { cron: event.target.value } : { event: event.target.value })} /></label><label>Timezone<select value={String(step.timezone ?? "Asia/Kolkata")} onChange={(event) => onPatch({ timezone: event.target.value })}><option>Asia/Kolkata</option><option>UTC</option></select></label></> : kind === "approval" ? <label>Decision prompt<textarea rows={4} value={String(step.prompt ?? "")} onChange={(event) => onPatch({ prompt: event.target.value })} /></label> : <><label>Connected account<select defaultValue="workspace"><option value="workspace">Connected workspace</option></select></label><label>Action<input value={String(step.action ?? step.method ?? step.name)} onChange={(event) => onPatch({ action: event.target.value })} /></label><label>Input or message<input value={String(step.input ?? "")} onChange={(event) => onPatch({ input: event.target.value })} placeholder="Choose data from an earlier module" /></label></>}</div>{variables.length ? <div className="growth-inspector-section variable-picker"><span>Data from earlier modules</span><small>Choose a value to insert it without writing an expression.</small>{variables.map((variable) => <button key={`${variable.stepId}.${variable.path}`} onClick={() => insertVariable(variable.expression)}><b>{variable.stepName}</b><span>{variable.label}</span></button>)}</div> : null}<div className="growth-inspector-section"><span>Failure handling</span><label className="inspector-toggle"><span><b>Stop the run</b><small>Keep the error visible in history</small></span><input type="checkbox" defaultChecked /></label></div><footer>{!isStart ? <button className="inspector-delete" onClick={onDelete}><Trash2 size={14} />Delete step</button> : <span />}<button className="inspector-done" onClick={onClose}>Done</button></footer></aside>;
}

function RunDialog({ busy, triggerJson, onTriggerJson, onClose, onRun }: { busy: boolean; triggerJson: string; onTriggerJson: (value: string) => void; onClose: () => void; onRun: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}><section className="run-modal growth-run-modal" role="dialog" aria-modal="true" aria-labelledby="run-modal-title"><header><div><span>Live execution</span><h2 id="run-modal-title">Run this automation once?</h2></div><button aria-label="Close" disabled={busy} onClick={onClose}><X size={18} /></button></header><p>This is a real run against connected services. External writes still pause at approval steps.</p><div className="preflight"><div><LockKeyhole size={17} /><span><b>Safety stays on</b>Approvals and connection checks are enforced</span></div><div><Zap size={17} /><span><b>Live usage</b>Credits are charged only for completed billable steps</span></div></div><label className="trigger-data">Trigger data<textarea rows={5} value={triggerJson} onChange={(event) => onTriggerJson(event.target.value)} /></label><footer><button disabled={busy} onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy} onClick={onRun}><Play size={15} fill="currentColor" />{busy ? "Running…" : "Run with live actions"}</button></footer></section></div>;
}

function ArrowRightIcon() { return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M3 7.5h8M8 4l3.5 3.5L8 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
