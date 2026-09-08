"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { useCredits } from "@/components/ui/credits";
import { cn } from "@/lib/utils";
import type { Workflow } from "@/lib/data/workflows";
import { idSeed, newStepFrom, palette, type PaletteBlock } from "@/lib/workflows/blocks";
import { relTime } from "@/lib/workflows/display";
import {
  addCase,
  appendAfter,
  canMove as canMoveStep,
  duplicateStep,
  insertOnEdge,
  moveStep,
  removeCase,
  renameCase,
  replaceTrigger,
  updateStep,
  uniqueStepId,
} from "@/lib/workflows/edit";
import type { EdgeRef } from "@/lib/workflows/graph";
import { limitations } from "@/lib/workflows/limitations";
import { requiredAppsOf, type AppConnection } from "@/lib/workflows/apps";
import {
  appList,
  ConnectedAppIcons,
  ConnectApps,
  useAppConnections,
} from "@/components/connect-apps";
import { gapCount, lintGraph, liveWrites, setupGaps } from "@/lib/workflows/validate";
import { requestRun } from "@/lib/workflows/run-request";
import { BrandGap, useBrandReadiness } from "@/components/brand-readiness";
import { needsBrandGrounding } from "@/lib/workflows/apps";
import type { WorkflowGraph } from "@/lib/workflows/types";
import {
  adoptableAfterSave,
  connectSteps,
  diffWorkflowGraphs,
  draftIssues,
  initialCanvasPositions,
  positionsAfterGraphChange,
  removeStepDetached,
  type WorkflowPositions,
} from "@/lib/workflows/editor";
import { BuilderChat, type ChatSuggestion } from "../builder-chat";
import { WorkflowLogo } from "../workflow-logo";
import { Canvas } from "./canvas";
import { Inspector } from "./inspector";
import { Runs, type RunEntry } from "./runs";
import { StepPicker } from "./step-picker";

/**
 * The automation editor — a visual builder over the same graph the AI writes.
 *
 * The canvas, the inspector and the AI chat are three ways to edit ONE piece
 * of state (`graph`): every gesture produces a new graph through the pure
 * helpers in src/lib/workflows/edit.ts, gets linted client-side, and is
 * re-validated by the server on save. Nothing here knows how a workflow was
 * originally created, which is the point — AI-built and hand-built
 * automations are the same object.
 */

interface WorkflowDetail extends Workflow {
  logo?: string | null;
}

const SUGGESTIONS: ChatSuggestion[] = [
  {
    icon: "plus",
    label: "Add a Slack notification",
    desc: "Post the result to a channel at the end.",
    prompt: "Post the final result to Slack at the end of this workflow",
  },
  {
    icon: "hand",
    label: "Add an approval step",
    desc: "Pause for review before anything goes out.",
    prompt: "Ask me to approve before anything is published or sent",
  },
  {
    icon: "filter",
    label: "Only run when it matters",
    desc: "Skip the routine cases automatically.",
    prompt: "Only continue when the item is actually important, otherwise stop",
  },
];

const WEBHOOK_TRIGGER = palette().find((block) => block.id === "trigger:webhook")!;

type Tab = "editor" | "runs";

export default function WorkflowDetailPage() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const workflowId = params?.id ?? "";
  const creating = searchParams.get("creating") === "1";
  const router = useRouter();
  const { toast } = useToast();
  const { refresh: refreshCredits } = useCredits();

  const [wf, setWf] = useState<WorkflowDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  /** A load that failed for any other reason — offline, 500, bad JSON. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [active, setActive] = useState(false);
  const [togglingActive, setTogglingActive] = useState(false);
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [tab, setTab] = useState<Tab>("editor");
  /**
   * Whether the workspace profile says what the product does. Read from the
   * shared endpoint rather than off this workflow's own response, so the
   * editor, the builder chat and the template dialog cannot disagree about it.
   */
  const { readiness } = useBrandReadiness();

  // ---- editor state ----
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  /** Last persisted graph — the dirty check and Discard both compare to this. */
  const [savedGraph, setSavedGraph] = useState<string>("");
  const [positions, setPositions] = useState<WorkflowPositions>({});
  const [savedPositions, setSavedPositions] = useState<string>("{}");
  const [revision, setRevision] = useState(0);
  const [publishedGraph, setPublishedGraph] = useState<WorkflowGraph | null>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  /** A setup/provider save failure pauses auto-save without pretending it is a conflict. */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** Last persisted name. `dirty` was graph-only, so a rename could never be saved. */
  const [savedName, setSavedName] = useState<string>("");
  // Read inside `refresh`, which must not re-create itself on every keystroke.
  const savedNameRef = useRef(savedName);
  const [history, setHistory] = useState<{ graph: WorkflowGraph; positions: WorkflowPositions }[]>([]);
  const [, setFuture] = useState<{ graph: WorkflowGraph; positions: WorkflowPositions }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [picker, setPicker] = useState<{ mode: "trigger" | "step"; edge?: EdgeRef } | null>(null);
  const [saving, setSaving] = useState(false);
  /** Only a save the user asked for spins the Save button. Auto-save must be invisible. */
  const [manualSaving, setManualSaving] = useState(false);
  const [runningNow, setRunningNow] = useState(false);
  const [chatOpen, setChatOpen] = useState(searchParams.get("chat") === "1");
  const [modulesOpen, setModulesOpen] = useState(true);
  const [replay, setReplay] = useState<Record<string, "done" | "failed"> | undefined>();
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  /**
   * The editor state as it is RIGHT NOW, readable from an async callback.
   *
   * Auto-save snapshots the draft, waits on the network, and then has to
   * decide whether its answer is still relevant. Reading `graph` out of the
   * closure would hand it the value from when the request started — which is
   * exactly the value it must not trust.
   */
  const graphRef = useRef<WorkflowGraph | null>(null);
  const positionsRef = useRef<WorkflowPositions>({});
  const nameRef = useRef<string>("");
  const revisionRef = useRef(0);
  /** Guards against two saves overlapping without making `save` re-create itself. */
  const savingRef = useRef(false);
  /**
   * Saves run one at a time, in order.
   *
   * Pressing Save or Publish a fraction of a second after the auto-save timer
   * fired used to be swallowed by the "already saving" guard: the button did
   * nothing, and Publish quietly gave up. Queueing behind the request in
   * flight means the click always lands.
   */
  const saveQueue = useRef<Promise<boolean>>(Promise.resolve(true));

  /**
   * Load (or reload) the automation. `keepEdits` leaves the canvas alone so a
   * refresh after a test run can't throw away work in progress.
   */
  const refresh = useCallback(
    async (keepEdits = false) => {
      if (!workflowId) return;
      try {
        const res = await fetch(`/api/workflows/${workflowId}`);
        if (res.status === 404) {
          setNotFound(true);
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          workflow?: WorkflowDetail;
          graph?: WorkflowGraph;
          positions?: WorkflowPositions;
          revision?: number;
          publishedGraph?: WorkflowGraph;
          runs?: RunEntry[];
          error?: string;
        } | null;
        if (!res.ok || !data) {
          throw new Error(data?.error ?? `The server answered ${res.status}.`);
        }
        if (!data.workflow) {
          setNotFound(true);
          return;
        }
        setLoadError(null);
        const fetched = data.workflow;
        setWf((current) => {
          if (!keepEdits || !current) return fetched;
          // A background refresh must not overwrite what is being typed. The
          // run poll fires every 5s while a run is in flight, so without this
          // a rename made during a run is silently reverted mid-keystroke.
          const renaming = current.name !== savedNameRef.current;
          return { ...current, ...fetched, ...(renaming ? { name: current.name } : {}) };
        });
        setActive(data.workflow.active);
        setSavedName(data.workflow.name);
        setRuns(data.runs ?? []);
        if (data.graph) {
          const fetchedPositions = initialCanvasPositions(data.graph, data.positions ?? {});
          setSavedGraph(JSON.stringify(data.graph));
          setSavedPositions(JSON.stringify(fetchedPositions));
          setRevision(data.revision ?? 0);
          setPublishedGraph(data.publishedGraph ?? data.graph);
          setSaveConflict(false);
          setSaveError(null);
          if (!keepEdits) {
            setGraph(data.graph);
            setPositions(fetchedPositions);
            setSelectedId(null);
            setHistory([]);
            setFuture([]);
          }
        }
      } catch (err) {
        // A failed load used to leave the page looking like an empty workflow.
        // Only say so when there is nothing on screen yet — a refresh that
        // fails behind a populated editor should not blow the editor away.
        setLoadError(err instanceof Error ? err.message : "Could not reach the server.");
      }
    },
    [workflowId],
  );

  useEffect(() => {
    savedNameRef.current = savedName;
  }, [savedName]);

  // Keep the "latest value" refs in step with state. They exist so an async
  // save can tell what changed while its request was in flight.
  useEffect(() => {
    graphRef.current = graph;
    positionsRef.current = positions;
    nameRef.current = wf?.name ?? "";
    revisionRef.current = revision;
  }, [graph, positions, wf?.name, revision]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await refresh();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  /**
   * Poll while any run is unfinished.
   *
   * Nothing polled at all before, so a run started by cron or a webhook never
   * appeared without a full page reload, and a `running` row spun forever even
   * after the run had finished. `queued` and `waiting` count too: a queued run
   * is waiting on the next beat, and a waiting one becomes queued the moment
   * somebody approves it from another tab.
   */
  const openRuns = runs.filter(
    (r) => r.status === "queued" || r.status === "running" || r.status === "waiting",
  ).length;
  const inFlight = openRuns > 0;
  /**
   * Executing RIGHT NOW — which is not the same as unfinished. The canvas
   * animates its edges from this, and `queued` (waiting for the next beat) and
   * `waiting` (parked on a human decision, for up to 30 days) both had the
   * whole graph pulsing as though data were moving through it.
   */
  const driving = runs.some((r) => r.status === "running");
  useEffect(() => {
    if (!inFlight || notFound) return;
    const id = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(id);
  }, [inFlight, notFound, refresh]);

  const graphDirty = Boolean(graph) && JSON.stringify(graph) !== savedGraph;
  const positionsDirty = JSON.stringify(positions) !== savedPositions;
  // The rename WAS sent by save(), but `dirty` only looked at the graph — so
  // the Save button stayed disabled and a rename persisted only if you happened
  // to also touch a step.
  const nameDirty = Boolean(wf) && (wf?.name ?? "") !== savedName;
  const dirty = graphDirty || positionsDirty || nameDirty;

  // Leaving with unsaved changes is almost always a mistake.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const gaps = useMemo(() => (graph ? setupGaps(graph) : {}), [graph]);
  const issues = useMemo(() => (graph ? lintGraph(graph) : []), [graph]);
  const editorIssues = useMemo(() => (graph ? draftIssues(graph) : []), [graph]);
  /**
   * True things about this automation that no amount of filling fields in will
   * change — it polls rather than pushes, the app is simulated, the provider
   * forbids what the step is arranged to do. Derived from the LIVE graph so
   * swapping a trigger or a tool updates it as you build, and refined by what
   * the enable path actually resolved once the automation has been switched on.
   */
  /**
   * The accounts this automation needs, and whether the workspace has them.
   *
   * Derived from the LIVE graph, not the saved one, so an AI edit or a block
   * dropped on the canvas names its account straight away — and deliberately
   * NOT part of `limitations()`, which is pure and re-derived on every
   * keystroke and so cannot see a workspace fact without lying about how
   * fresh it is.
   */
  const requiredApps = useMemo(() => (graph ? requiredAppsOf(graph) : []), [graph]);
  const {
    connections,
    missing: unconnectedApps,
    busy: connectBusy,
    connect,
  } = useAppConnections(requiredApps);

  /**
   * Which apps are really demo mode, rather than merely on the static list.
   *
   * Google Business Profile is the whole reason this is passed instead of
   * assumed: it sits in `SIMULATED_APPS` permanently because Composio has no
   * toolkit for it, but we run it ourselves, so on a deployment with a Google
   * client `steps.ts` executes those steps for REAL. The panel used to promise
   * "produce realistic results without anything reaching Google Business
   * Profile" and then the run reached Google Business Profile — and failed
   * against it, after a human had already approved the reply.
   *
   * `null` until every row has landed, which keeps the static fallback (and
   * the honest banner on a deployment with no Google client) rather than
   * flickering a wrong answer from a half-loaded status.
   */
  const demoApps = useMemo(
    () =>
      connections.some((c) => c.status === "unknown")
        ? null
        : connections.filter((c) => c.status === "simulated").map((c) => c.app),
    [connections],
  );

  const limits = useMemo(
    () =>
      graph
        ? limitations(
            graph,
            { mode: wf?.trigger?.delivery, reason: wf?.trigger?.deliveryReason },
            demoApps,
          )
        : [],
    [graph, wf?.trigger?.delivery, wf?.trigger?.deliveryReason, demoApps],
  );

  /**
   * Pressing Run gives an app-event trigger no event, so it runs on the
   * trigger's canned sample (steps.ts). Everything the run then does with that
   * invented event is real, which is what `runNow` warns about and what the
   * "finished" toast has to stop calling a success.
   */
  const sampleFed = Boolean(graph && graph.steps[graph.start]?.type === "app_event_trigger");
  const blocking = issues.filter((i) => i.severity === "error");
  const publishBlocks = blocking.length + editorIssues.length;

  /**
   * This automation generates something, but nothing has told us what the
   * business is — so the drafts and pictures will be about nobody in
   * particular.
   *
   * Derived from the LIVE graph rather than the saved one, so adding an AI or
   * image step raises it immediately and deleting the last one clears it.
   * `needsBrandGrounding` is what decides that, so the answer stays the same
   * here as in the chat preview — this used to test for `ai_step` by hand and
   * therefore stayed silent for a workflow whose only generated output was an
   * image.
   */
  const genericDrafts = needsBrandGrounding(graph ?? { start: "", steps: {} });

  // ---- mutations ----------------------------------------------------------
  /**
   * Replace the draft graph.
   *
   * The history push and the position re-layout used to happen INSIDE the
   * `setGraph` updater. React is allowed to run an updater more than once for
   * the same change, so every edit could be recorded twice and the layout
   * recomputed twice — one keystroke, two undo steps. Reading the current
   * value from a ref keeps the whole edit as one plain, once-only update.
   */
  const apply = useCallback((next: WorkflowGraph) => {
    const current = graphRef.current;
    if (!current || next === current) return;
    const placed = positionsRef.current;
    setSaveError(null);
    setHistory((h) => [...h.slice(-49), { graph: current, positions: placed }]);
    setFuture([]);
    setPositions(positionsAfterGraphChange(current, next, placed));
    setGraph(next);
  }, []);

  const applyPositions = useCallback((next: WorkflowPositions) => {
    if (!graph || JSON.stringify(next) === JSON.stringify(positions)) return;
    setHistory((h) => [...h.slice(-49), { graph, positions }]);
    setFuture([]);
    setPositions(next);
  }, [graph, positions]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (!h.length) return h;
      const previous = h[h.length - 1];
      if (graph) setFuture((items) => [...items.slice(-49), { graph, positions }]);
      setGraph(previous.graph);
      setPositions(previous.positions);
      return h.slice(0, -1);
    });
  }, [graph, positions]);

  const redo = useCallback(() => {
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[items.length - 1];
      if (graph) setHistory((h) => [...h.slice(-49), { graph, positions }]);
      setGraph(next.graph);
      setPositions(next.positions);
      return items.slice(0, -1);
    });
  }, [graph, positions]);

  function onInsert(edge: EdgeRef) {
    setPicker({ mode: "step", edge });
  }

  function onPick(block: PaletteBlock) {
    if (!graph || !picker) return;
    const result =
      picker.mode === "trigger"
        ? replaceTrigger(graph, block)
        : picker.edge
          ? insertOnEdge(graph, picker.edge, block)
          : appendAfter(graph, graph.start, block);
    apply(result.graph);
    setSelectedId(result.stepId);
    setPicker(null);
  }

  function changeTrigger() {
    setPicker({ mode: "trigger" });
  }

  function useWebhookTrigger() {
    if (!graph) return;
    const result = replaceTrigger(graph, WEBHOOK_TRIGGER);
    apply(result.graph);
    setSelectedId(result.stepId);
  }

  function addFromLibrary(block: PaletteBlock) {
    if (!graph) return;
    const result = appendAfter(graph, graph.start, block);
    apply(result.graph);
    setSelectedId(result.stepId);
  }

  function dropFromLibrary(blockId: string, position: { x: number; y: number }, edge: EdgeRef | null) {
    if (!graph) return;
    const block = palette().find((candidate) => candidate.id === blockId);
    if (!block) return;
    if (block.category === "trigger") {
      const result = replaceTrigger(graph, block);
      apply(result.graph);
      setPositions((current) => ({ ...current, [result.stepId]: position }));
      setSelectedId(result.stepId);
      return;
    }
    if (edge) {
      const result = insertOnEdge(graph, edge, block);
      apply(result.graph);
      setPositions((current) => ({ ...current, [result.stepId]: position }));
      setSelectedId(result.stepId);
      return;
    }
    const id = uniqueStepId(graph, idSeed(block));
    const next = structuredClone(graph);
    next.steps[id] = newStepFrom(block);
    apply(next);
    setPositions((current) => ({ ...current, [id]: position }));
    setSelectedId(id);
  }

  function onDelete(id: string) {
    if (!graph) return;
    apply(removeStepDetached(graph, id));
    if (selectedId === id) setSelectedId(null);
  }

  /**
   * Point one slot at a different step — the inspector's "then go to" selector,
   * and a handle-to-node drag on the canvas.
   *
   * Canvas rewiring is atomic and leaves disconnected modules visible in the
   * draft, so an accidental gesture never silently deletes work.
   */
  function onRewire(edge: EdgeRef, target: string | null) {
    if (!graph) return;
    apply(connectSteps(graph, edge, target));
  }

  // ---- persistence --------------------------------------------------------
  /**
   * Persist the draft.
   *
   * `silent` marks the one-second auto-save, which has to be invisible: a
   * toast on every pause in typing, a spinner blinking on the Save button and
   * an undo stack wiped on a timer are none of them things somebody asked for
   * by typing a character.
   */
  const runSave = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
    const current = graphRef.current;
    if (!current || savingRef.current) return false;
    // What this request is about to send. Everything typed after this line is
    // newer than the server's answer will be.
    const sent = { graph: current, positions: positionsRef.current, name: nameRef.current };
    const sentGraph = JSON.stringify(current);
    const sentPositions = JSON.stringify(sent.positions);
    const sentName = sent.name;
    savingRef.current = true;
    setSaving(true);
    if (!silent) setManualSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          graph: current,
          positions: positionsRef.current,
          baseRevision: revisionRef.current,
          name: sentName,
        }),
      });
      const data = (await res.json()) as {
        workflow?: WorkflowDetail;
          graph?: WorkflowGraph;
          positions?: WorkflowPositions;
          revision?: number;
          error?: string;
          code?: string;
        };
      if (res.status === 409 && data.code === "revision_conflict") {
        setSaveConflict(true);
        toast({ title: "Newer changes exist", description: "Reload them or save this draft as a copy.", tone: "warning" });
        return false;
      }
      const savedWorkflow = data.workflow;
      if (!res.ok || !savedWorkflow) {
        setSaveError(data.error ?? "Couldn't save the workflow.");
        toast({ title: "Couldn't save", description: data.error, tone: "danger" });
        return false;
      }

      // Take the server's answer only where the user has not moved on — see
      // `adoptableAfterSave`. Auto-save fires while somebody is still typing,
      // and writing the response straight back over the editor threw away
      // every keystroke made during the round trip: the field visibly
      // reverted and the caret jumped to the end. That is the "glitch while
      // editing".
      const adopt = adoptableAfterSave(sent, {
        graph: graphRef.current ?? current,
        positions: positionsRef.current,
        name: nameRef.current,
      });

      setWf((currentWf) =>
        !adopt.name && currentWf
          ? { ...currentWf, ...savedWorkflow, name: currentWf.name }
          : savedWorkflow,
      );
      setSavedName(savedWorkflow.name);
      // APPLY the graph the server stored, don't just remember it.
      //
      // The server repairs references on save, so what comes back is usually
      // not byte-identical to what was sent. Recording it as `savedGraph`
      // while leaving `graph` at the pre-repair version made `dirty` true
      // forever: "Unsaved changes" latched on, beforeunload fired on every
      // navigation, and Run refused with "Save first" permanently.
      if (data.graph) {
        setSavedGraph(JSON.stringify(data.graph));
        if (adopt.graph) setGraph(data.graph);
      } else {
        setSavedGraph(sentGraph);
      }
      const storedPositions = data.positions ?? (JSON.parse(sentPositions) as WorkflowPositions);
      setSavedPositions(JSON.stringify(storedPositions));
      if (adopt.positions) setPositions(storedPositions);
      setRevision(data.revision ?? revisionRef.current + 1);
      setSaveConflict(false);
      setSaveError(null);
      if (!silent) {
        setHistory([]);
        setFuture([]);
        toast({ title: "Draft saved", description: "Published behavior is unchanged." });
      }
      return true;
    } catch {
      setSaveError("Please try again.");
      toast({ title: "Couldn't save", description: "Please try again.", tone: "danger" });
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setManualSaving(false);
    }
  }, [workflowId, toast]);

  const save = useCallback(
    (options: { silent?: boolean } = {}) => {
      const next = saveQueue.current.then(() => runSave(options));
      saveQueue.current = next.catch(() => false);
      return next;
    },
    [runSave],
  );

  // Auto-save one second after the last edit. `positions` and the name are in
  // the dependency list so that dragging or renaming restarts the timer too —
  // otherwise the first keystroke of a rename scheduled a save into the middle
  // of the word.
  useEffect(() => {
    if (!dirty || saving || saveConflict || saveError || !graph) return;
    const timer = window.setTimeout(() => void save({ silent: true }), 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, saving, saveConflict, saveError, graph, positions, wf?.name, save]);

  const publish = useCallback(async () => {
    if (!graph || !publishedGraph) return;
    if (dirty && !(await save())) return;
    const diff = diffWorkflowGraphs(publishedGraph, graph);
    const summary = [
      diff.added.length ? `Added: ${diff.added.join(", ")}` : "",
      diff.removed.length ? `Removed: ${diff.removed.join(", ")}` : "",
      diff.changed.length ? `Changed: ${diff.changed.join(", ")}` : "",
      liveWrites(graph, demoApps).length
        ? `External writes: ${liveWrites(graph, demoApps).join(", ")}`
        : "",
    ].filter(Boolean).join("\n");
    if (!window.confirm(`Publish this draft?\n\n${summary || "No module changes."}`)) return;
    const res = await fetch(`/api/workflows/${workflowId}/publish`, { method: "POST" });
    const data = (await res.json().catch(() => null)) as { graph?: WorkflowGraph; error?: string } | null;
    if (!res.ok || !data?.graph) {
      toast({ title: "Couldn't publish", description: data?.error, tone: "danger" });
      return;
    }
    setPublishedGraph(data.graph);
    toast({ title: "Published", description: "Scheduled and external runs now use this version." });
  }, [demoApps, dirty, graph, publishedGraph, save, toast, workflowId]);

  const saveAsCopy = useCallback(async () => {
    if (!graph) return;
    const res = await fetch(`/api/workflows/${workflowId}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph, positions, name: wf?.name }),
    });
    const data = (await res.json().catch(() => null)) as { id?: string; error?: string } | null;
    if (!res.ok || !data?.id) {
      toast({ title: "Couldn't save a copy", description: data?.error, tone: "danger" });
      return;
    }
    router.push(`/app/workflows/${data.id}`);
  }, [graph, positions, router, toast, wf?.name, workflowId]);

  // Cmd/Ctrl+S saves, Cmd/Ctrl+Z undoes — the two shortcuts people reach for.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "s") {
        e.preventDefault();
        if (dirty) void save();
      } else if (e.key === "z" && !e.shiftKey) {
        const el = document.activeElement?.tagName;
        if (el === "INPUT" || el === "TEXTAREA") return;
        e.preventDefault();
        undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        const el = document.activeElement?.tagName;
        if (el === "INPUT" || el === "TEXTAREA") return;
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, save, undo, redo]);

  async function runNow() {
    if (runningNow || !wf || !graph) return;
    if (dirty) {
      toast({
        title: "Save first",
        description: "Run once uses the latest saved draft — save your changes, then run.",
        tone: "warning",
      });
      return;
    }
    // Run has no real event to work from, so an app-event trigger is handed its
    // canned sample — but every step AFTER it is real. A reply published to a
    // review that nobody left is still published, and cannot be taken back, so
    // it gets asked about rather than assumed.
    const writes = sampleFed ? liveWrites(graph, demoApps) : [];
    if (
      writes.length > 0 &&
      !window.confirm(
        `Run “${wf.name}” now?\n\n` +
          `There is no real event to run on, so the trigger uses sample data — but ` +
          `these steps act on your connected accounts for real, and can't be undone:\n\n` +
          writes.map((w) => `  • ${w}`).join("\n"),
      )
    ) {
      return;
    }
    setRunningNow(true);
    try {
      const outcome = await requestRun(workflowId);
      // The balance may have moved — a run is billed, and a route-side failure
      // refunds it. Re-read either way rather than guessing which.
      void refreshCredits();
      if (outcome.kind === "insufficient_credits") {
        toast({
          title: "Not enough credits",
          description: `A run costs ${outcome.cost} credits — balance: ${outcome.balance}.`,
          tone: "warning",
        });
        return;
      }
      if (outcome.kind === "refused") {
        toast({ title: "Run failed", description: outcome.message, tone: "danger" });
        return;
      }
      if (outcome.kind === "unknown") {
        // NOT a failed run, and saying so was this button's worst behaviour.
        // The route drives the whole workflow inside the request while nginx
        // cuts a public request at 60s, so an ordinary two-AI-step automation
        // answers the browser with nothing and finishes anyway. "Run failed —
        // please try again" then invited a second press, which (before the key
        // was reused) meant a second charge and a second real publish.
        toast({
          title: outcome.reason === "network" ? "Couldn't reach the server" : "Still running",
          description:
            outcome.reason === "network"
              ? "The run may have started anyway — the Runs tab has the truth."
              : "It outlasted the wait and carries on in the background. The Runs tab updates as it lands.",
        });
      } else if (outcome.status === "completed") {
        // A green Run on an automation that cannot poll is the most misleading
        // signal in this editor: Run feeds the trigger its canned sample, so it
        // passes exactly the same whether or not the trigger was ever told WHAT
        // to watch. "Finished successfully" was standing for both.
        const pending = gapCount(gaps);
        toast({
          title: "Run complete",
          description: pending
            ? `${wf.name} finished on sample data — ${pending} step${pending === 1 ? "" : "s"} still ${pending === 1 ? "needs" : "need"} setup before it can run for real.`
            : sampleFed
              ? `${wf.name} finished on the trigger's sample event — every later step ran for real.`
              : `${wf.name} finished successfully.`,
          tone: pending ? "warning" : undefined,
        });
      } else if (outcome.status === "failed") {
        toast({ title: "Run failed", description: outcome.error, tone: "danger" });
      } else if (outcome.status === "waiting") {
        toast({
          title: "Waiting for your review",
          description: "Approve or reject it below — nothing is sent until you do.",
        });
      } else if (outcome.duplicate) {
        // This press re-sent the key of an attempt we never got an answer for,
        // so it joined that run instead of starting a second one.
        toast({
          title: "Already running",
          description: "The run you started earlier is still going — press Run again once it lands.",
        });
      } else {
        toast({ title: "Run queued", description: `${wf.name} starts on the next beat.` });
      }
      await refresh(true);
      setTab("runs");
    } finally {
      setRunningNow(false);
    }
  }

  /** Record an approval decision, then let the beat finish the run. */
  async function decide(run: RunEntry, decision: "approve" | "reject") {
    try {
      const res = await fetch(`/api/workflows/${workflowId}/runs/${run.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const data = (await res.json()) as {
        error?: string;
        alreadyResolved?: boolean;
        status?: string;
      };
      if (!res.ok) {
        toast({ title: "Couldn't record that", description: data.error, tone: "danger" });
        return;
      }
      if (data.alreadyResolved) {
        toast({ title: "Already decided", description: "This run has moved on." });
      } else if (data.status === "failed") {
        // The remaining steps ran and one of them failed — say so here rather
        // than leaving the user to notice it in the run list.
        toast({ title: "Run failed after approval", description: data.error, tone: "danger" });
      } else if (data.status === "completed") {
        toast({
          title: decision === "approve" ? "Approved and sent" : "Rejected",
          description:
            decision === "approve" ? "The rest of the run finished." : "Nothing was sent.",
        });
      } else {
        // Still queued — a beat won the row first, or this run needs another
        // decision further down.
        toast({
          title: decision === "approve" ? "Approved" : "Rejected",
          description: "Finishing now — this updates in a moment.",
        });
      }
      await refresh(true);
    } catch {
      toast({ title: "Couldn't record that", tone: "danger" });
    }
  }

  async function toggleActive(next: boolean) {
    // Without this a double-click sends two PATCHes whose responses can land
    // out of order, leaving the switch showing the opposite of the truth.
    if (togglingActive) return;
    // Switching on is a promise that it can run. The server already refuses
    // over blank fields; an account nobody ever connected fails just as
    // certainly, one step later, so it is refused here — where the Connect
    // buttons are — rather than in a failed run tomorrow.
    if (next && unconnectedApps.length) {
      toast({
        title: `Connect ${appList(unconnectedApps)} first`,
        description: "Every run would stop at the first step that needs it.",
        tone: "warning",
      });
      return;
    }
    // The same refusal the server makes, made here so it arrives with the
    // notice explaining it rather than as a bare 409. `readiness` is null
    // while loading or after a failed read — both mean "no evidence", so the
    // server has the last word either way.
    if (next && genericDrafts && readiness && !readiness.knowsProduct) {
      toast({
        title: "Tell us about your business first",
        description:
          "This one writes with AI. With an empty profile every scheduled run publishes generalities — Settings → Brand voice.",
        tone: "warning",
      });
      return;
    }
    const previous = active;
    setActive(next);
    setTogglingActive(true);
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      const data = (await res.json()) as {
        error?: string;
        demo?: boolean;
        gaps?: Record<string, string[]>;
      };
      if (!res.ok) {
        setActive(previous);
        // Say WHICH steps, from the 409's gaps map. "Finish setting up every
        // step first" left the user to find them by hand.
        const missing = Object.entries(data.gaps ?? {}).flatMap(([id, items]) =>
          items.map((item) => `${graph?.steps[id]?.title ?? id}: ${item}`),
        );
        toast({
          title: "Can't switch this on yet",
          description: missing.length
            ? missing.slice(0, 3).join(" · ") +
              (missing.length > 3 ? ` · and ${missing.length - 3} more` : "")
            : data.error,
          tone: "warning",
        });
        return;
      }
      // A demo-mode PATCH persists nothing, so reporting success is a lie the
      // user only discovers on reload.
      if (data.demo) {
        setActive(previous);
        toast({
          title: "Sign in to switch automations on",
          description: "Preview mode can't save this.",
          tone: "warning",
        });
        return;
      }
      toast({ title: next ? "Automation resumed" : "Automation paused" });
    } catch {
      setActive(previous);
      toast({ title: "Couldn't change that", tone: "danger" });
    } finally {
      setTogglingActive(false);
    }
  }

  async function destroy() {
    if (!window.confirm(`Delete “${wf?.name}”? Its run history goes too. This can't be undone.`)) {
      return;
    }
    try {
      const res = await fetch(`/api/workflows/${workflowId}`, { method: "DELETE" });
      if (!res.ok) {
        toast({ title: "Couldn't delete", tone: "danger" });
        return;
      }
      toast({ title: "Automation deleted" });
      router.push("/app/workflows");
    } catch {
      toast({ title: "Couldn't delete", tone: "danger" });
    }
  }

  if (notFound) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <p className="text-[14px] text-ink-muted">This automation doesn&apos;t exist.</p>
        <Button variant="secondary" onClick={() => router.push("/app/workflows")}>
          All automations
        </Button>
      </div>
    );
  }

  // A load failure with nothing on screen is NOT an empty workflow, and saying
  // so is how a server outage came to look like a missing automation.
  if (loadError && !wf) {
    return (
      <div className="flex flex-col items-center gap-4 py-20 text-center">
        <Icon name="info" size={26} className="text-danger" />
        <div>
          <div className="text-[15px] font-semibold text-ink">Couldn&apos;t load this automation</div>
          <p className="mt-1 text-[13.5px] text-ink-subtle">{loadError}</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void refresh()}>Try again</Button>
          <Button variant="secondary" onClick={() => router.push("/app/workflows")}>
            All automations
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Header
        wf={wf}
        connectedTools={connections.every((connection) => connection.status === "connected") ? connections : []}
        active={active}
        dirty={dirty}
        saving={manualSaving}
        runningNow={runningNow}
        blocking={publishBlocks}
        chatOpen={chatOpen}
        openRuns={openRuns}
        togglingActive={togglingActive}
        canUndo={history.length > 0}
        conflict={saveConflict}
        saveError={saveError}
        onBack={() => router.push("/app/workflows")}
        onRename={(name) => setWf((w) => (w ? { ...w, name } : w))}
        onToggleActive={toggleActive}
        onTest={() => void runNow()}
        onSave={() => void save()}
        onUndo={undo}
        onPublish={() => void publish()}
        onReload={() => void refresh()}
        onSaveAsCopy={() => void saveAsCopy()}
        onToggleChat={() => setChatOpen((o) => !o)}
        onDelete={() => void destroy()}
      />

      <div className="flex justify-center">
        <div className="flex gap-1 rounded-full bg-inset p-1">
          <TabPill active={tab === "editor"} onClick={() => setTab("editor")}>
            <Icon name="sliders" size={14} className="mr-1.5 inline-block align-[-2px]" />
            Editor
          </TabPill>
          <TabPill
            active={tab === "runs"}
            onClick={() => {
              setTab("runs");
              setReplay(undefined);
            }}
          >
            Runs
            {runs.length > 0 && (
              <span className="ml-1.5 rounded-full bg-card px-1.5 text-[11px]">{runs.length}</span>
            )}
          </TabPill>
        </div>
      </div>

      {/* An approval that nobody is told about stalls silently until the run
          expires 30 days later. */}
      {runs.some((r) => r.status === "waiting") && (
        <button
          onClick={() => setTab("runs")}
          className="flex w-full items-start gap-2 rounded-card border border-brand bg-brand-subtle px-4 py-3 text-left"
        >
          <Icon name="hand" size={15} className="mt-0.5 flex-none text-brand" />
          <div className="min-w-0 text-[13px] text-ink-muted">
            <span className="font-semibold text-ink">Waiting for your review — </span>
            nothing is sent until you approve it. Open the Runs tab to decide.
          </div>
        </button>
      )}

      {loadError && wf && (
        <div className="flex items-start gap-2 rounded-card border border-warning-border bg-warning-surface px-4 py-3">
          <Icon name="info" size={15} className="mt-0.5 flex-none text-warning" />
          <div className="min-w-0 flex-1 text-[13px] text-ink-muted">
            Couldn&apos;t refresh — {loadError} What you see may be out of date.
          </div>
          <button
            onClick={() => void refresh(true)}
            className="flex-none text-[12.5px] font-semibold text-brand hover:underline"
          >
            Retry
          </button>
        </div>
      )}

      {(blocking.length > 0 || editorIssues.length > 0) && (
        <div className="flex items-start gap-2 rounded-card border border-danger-border bg-danger-surface px-4 py-3">
          <Icon name="info" size={15} className="mt-0.5 flex-none text-danger" />
          <div className="min-w-0 text-[13px] text-ink-muted">
            <span className="font-semibold text-danger">This draft can&apos;t be published yet — </span>
            <button
              className="text-left hover:underline"
              onClick={() => setSelectedId(editorIssues[0]?.stepId ?? blocking[0]?.stepId ?? null)}
            >
              {editorIssues[0]?.message ?? blocking[0]?.message}
            </button>
          </div>
        </div>
      )}

      {/* The AI writes with whatever the workspace has told us about itself.
          Nothing here is broken, so this never blocks saving or switching on —
          but a draft written about no particular business is worth a word
          BEFORE it publishes to a real account, not after. */}
      <BrandGap
        className="flex items-start gap-2 rounded-card border border-warning-border bg-warning-surface px-4 py-3"
        readiness={readiness}
        needed={genericDrafts}
      />

      {/* Healthy tools live quietly beside the workflow name. Anything that
          needs attention keeps the roomy, actionable connection panel. */}
      {connections.some((connection) => connection.status !== "connected") && (
        <ConnectApps
          connections={connections}
          busy={connectBusy}
          onConnect={connect}
          note={
            unconnectedApps.length
              ? `Connect ${appList(unconnectedApps)} before switching this on. We'll return you here after setup; runs stop until the connection is ready.`
              : undefined
          }
        />
      )}

      {/* Neither an error nor a blank field, so neither of the banners above
          would ever carry it — and every one of these was previously found out
          by switching the automation on and watching what it did. Deliberately
          calm styling: nothing here is broken, it is the small print of what
          was just built, and it earns its place by being read BEFORE the first
          real run rather than explaining the first real run afterwards. */}
      {limits.length > 0 && (
        <div className="rounded-card border border-line bg-inset px-4 py-3">
          <div className="flex items-center gap-2">
            <Icon name="info" size={15} className="flex-none text-ink-subtle" />
            <span className="text-[13px] font-semibold text-ink">
              Worth knowing before you switch this on
            </span>
          </div>
          <ul className="mt-2 flex flex-col gap-1.5 pl-[23px]">
            {limits.map((limit, i) => (
              <li
                key={`${limit.stepId ?? "wf"}-${i}`}
                className="text-[12.5px] leading-relaxed text-ink-muted"
              >
                <button
                  type="button"
                  onClick={() => limit.stepId && setSelectedId(limit.stepId)}
                  disabled={!limit.stepId}
                  className="text-left font-semibold text-ink enabled:hover:underline"
                >
                  {limit.title}
                </button>{" "}
                — {limit.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="min-w-0">
          {tab === "editor" ? (
            !graph ? (
              <div className="h-[560px] min-h-[460px] animate-pulse rounded-card border border-line bg-inset lg:h-[calc(100vh-320px)]" />
            ) : (
              <div
                data-workflow-canvas-shell
                className="relative h-[560px] min-h-[460px] overflow-hidden rounded-card border border-line bg-inset shadow-xs lg:h-[calc(100vh-320px)]"
              >
                <Canvas
                  graph={graph}
                  positions={positions}
                  selectedId={selectedId}
                  gaps={gaps}
                  runStatus={replay}
                  running={driving}
                  onSelect={setSelectedId}
                  onInsert={onInsert}
                  onChangeTrigger={changeTrigger}
                  onMove={(id, dir) => apply(moveStep(graph, id, dir))}
                  onMoveNode={(id, position) => applyPositions({ ...positions, [id]: position })}
                  onDropBlock={dropFromLibrary}
                  onRewire={onRewire}
                  onDuplicate={(id) => {
                    const result = duplicateStep(graph, id);
                    apply(result.graph);
                    setSelectedId(result.stepId);
                  }}
                  onDelete={onDelete}
                  canMove={(id, dir) => canMoveStep(graph, id, dir)}
                />

                {creating && modulesOpen && !chatOpen && (
                  <div className="absolute inset-y-3 left-3 z-20 w-[min(300px,calc(100%-24px))] drop-shadow-xl">
                    <ModuleLibrary onPick={addFromLibrary} onClose={() => setModulesOpen(false)} />
                  </div>
                )}

                {chatOpen && (
                  <div className="absolute inset-y-3 left-3 z-20 w-[min(400px,calc(100%-24px))] drop-shadow-xl max-md:fixed max-md:inset-x-3 max-md:bottom-3 max-md:top-20 max-md:z-50 max-md:w-auto">
                    <button
                      type="button"
                      aria-label="Hide AI panel"
                      onClick={() => setChatOpen(false)}
                      className="absolute right-2 top-2 z-30 flex h-8 w-8 items-center justify-center rounded-[8px] text-ink-muted transition-colors hover:bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                    >
                      <Icon name="x" size={15} />
                    </button>
                    <BuilderChat
                      placeholder="Describe a change — “add a Slack post at the end”"
                      suggestions={SUGGESTIONS}
                      context="detail"
                      mode="edit"
                      workflowId={workflowId}
                      graph={graph}
                      inputRef={chatInputRef}
                      onRunTest={() => void runNow()}
                      onSaved={(workflow) => router.push(`/app/workflows/${workflow.id}`)}
                      onEdited={(edited) => {
                        apply(edited.graph);
                        setWf((w) => (w ? { ...w, name: edited.name, desc: edited.description } : w));
                        setSelectedId(null);
                      }}
                    />
                  </div>
                )}

                {creating && !modulesOpen && !chatOpen && (
                  <div className="absolute left-3 top-3 z-20">
                    <Button variant="secondary" size="sm" icon="layers" onClick={() => setModulesOpen(true)}>
                      Modules
                    </Button>
                  </div>
                )}

                {selectedId && graph.steps[selectedId] && (
                  <div className="absolute inset-y-3 right-3 z-20 w-[min(380px,calc(100%-24px))] drop-shadow-xl">
                    <Inspector
                      graph={graph}
                      stepId={selectedId}
                      gaps={gaps[selectedId] ?? []}
                      workflowId={workflowId}
                      active={active}
                      publishedSecret={
                        publishedGraph?.steps[publishedGraph.start]?.type === "webhook_trigger"
                          ? String(publishedGraph.steps[publishedGraph.start].secret ?? "")
                          : ""
                      }
                      onPatch={(patch) => apply(updateStep(graph, selectedId, patch))}
                      onChangeTrigger={changeTrigger}
                      onUseWebhook={useWebhookTrigger}
                      onRewire={onRewire}
                      onAddCase={(value) => apply(addCase(graph, selectedId, value))}
                      onRemoveCase={(value) => apply(removeCase(graph, selectedId, value))}
                      onRenameCase={(from, to) => apply(renameCase(graph, selectedId, from, to))}
                      onDelete={() => onDelete(selectedId)}
                      onClose={() => setSelectedId(null)}
                    />
                  </div>
                )}
              </div>
            )
          ) : (
            <Runs
              runs={runs}
              onDecide={decide}
              onReplay={(run) => {
                // Mark which steps that run actually reached, then show the
                // canvas — the fastest way to see where a run stopped.
                const status: Record<string, "done" | "failed"> = {};
                for (const entry of run.journal ?? []) status[entry.stepId] = "done";
                // The canvas has always supported a red `x` and could never
                // render one: a failing step is never journaled, so the journal
                // alone paints the LAST SUCCESSFUL step and stops. log.failed
                // is the only record of where it actually died.
                if (run.failedStepId) status[run.failedStepId] = "failed";
                setReplay(status);
                setTab("editor");
              }}
            />
          )}
      </div>

      {picker && (
        <StepPicker mode={picker.mode} onPick={onPick} onClose={() => setPicker(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Module library
// ---------------------------------------------------------------------------

const LIBRARY_BLOCKS = palette().filter((block) => block.category !== "trigger");

function ModuleLibrary({ onPick, onClose }: { onPick: (block: PaletteBlock) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const shown = LIBRARY_BLOCKS.filter((block) =>
    `${block.label} ${block.desc} ${block.keywords ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  return (
    <aside className="flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-card shadow-xs">
      <div className="border-b border-line p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="text-[13px] font-semibold text-ink">Modules</div>
          <button
            type="button"
            aria-label="Hide modules"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-[7px] text-ink-muted transition-colors hover:bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="mb-2 text-[11.5px] text-ink-subtle">Drag to the canvas or click to add.</div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search modules"
          aria-label="Search modules"
          className="h-9 w-full rounded-[8px] border border-line bg-inset px-3 text-[12.5px] text-ink outline-none focus:border-brand"
        />
      </div>
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
        {shown.map((block) => (
          <button
            key={block.id}
            type="button"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("application/x-zidaneai-module", block.id);
            }}
            onClick={() => onPick(block)}
            className="rounded-[10px] border border-line bg-card p-2.5 text-left transition-colors hover:border-brand hover:bg-brand-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
          >
            <span className="block text-[12.5px] font-semibold text-ink">{block.label}</span>
            <span className="mt-0.5 line-clamp-2 block text-[11px] leading-snug text-ink-subtle">{block.desc}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  wf,
  connectedTools,
  active,
  dirty,
  saving,
  runningNow,
  blocking,
  chatOpen,
  openRuns,
  togglingActive,
  canUndo,
  conflict,
  saveError,
  onBack,
  onRename,
  onToggleActive,
  onTest,
  onSave,
  onUndo,
  onPublish,
  onReload,
  onSaveAsCopy,
  onToggleChat,
  onDelete,
}: {
  wf: WorkflowDetail | null;
  connectedTools: AppConnection[];
  active: boolean;
  dirty: boolean;
  saving: boolean;
  runningNow: boolean;
  blocking: number;
  chatOpen: boolean;
  /** Runs that have not landed yet — kept out of the success rate above. */
  openRuns: number;
  togglingActive: boolean;
  canUndo: boolean;
  conflict: boolean;
  saveError: string | null;
  onBack: () => void;
  onRename: (name: string) => void;
  onToggleActive: (next: boolean) => void;
  onTest: () => void;
  onSave: () => void;
  onUndo: () => void;
  onPublish: () => void;
  onReload: () => void;
  onSaveAsCopy: () => void;
  onToggleChat: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <Button variant="ghost" size="sm" icon="chevron-left" aria-label="All automations" onClick={onBack} />
        <div className="max-md:hidden">
          <WorkflowLogo logo={wf?.logo} active={active} />
        </div>

        <div
          data-workflow-identity
          className="min-w-[260px] flex-[1_1_320px] max-md:min-w-[160px] max-md:basis-[160px]"
        >
          <div className="flex min-w-0 items-center gap-2">
            <input
              value={wf?.name ?? ""}
              onChange={(e) => onRename(e.target.value)}
              placeholder="Untitled automation"
              aria-label="Automation name"
              className="min-w-[12ch] max-w-[calc(100%-60px)] truncate rounded-[8px] bg-transparent px-1.5 py-0.5 text-[16px] font-semibold text-ink outline-none transition-colors [field-sizing:content] hover:bg-inset focus:bg-inset"
            />
            <ConnectedAppIcons connections={connectedTools} />
          </div>
          <div className="truncate px-1.5 text-[12.5px] text-ink-subtle">
            {wf?.trigger ? triggerLine(wf.trigger) : wf?.desc}
          </div>
        </div>

        <div
          data-workflow-actions
          className="ml-auto flex flex-wrap items-center justify-end gap-2 max-md:w-full max-md:flex-nowrap"
        >
          {conflict ? (
            <span className="flex items-center gap-2 whitespace-nowrap text-[12px] font-semibold text-danger">
              Revision conflict
              <button onClick={onReload} className="hover:underline">Reload</button>
              <button onClick={onSaveAsCopy} className="hover:underline">Save as copy</button>
            </span>
          ) : saveError ? (
            <span className="max-w-[300px] truncate text-[12px] font-semibold text-danger" title={saveError}>
              Save blocked — {saveError}
            </span>
          ) : dirty && (
            <span className="whitespace-nowrap text-[12px] font-medium text-warning">
              Unsaved changes
            </span>
          )}
          <Button variant="ghost" size="sm" icon="refresh" aria-label="Undo" disabled={!canUndo} onClick={onUndo} />
          <Button
            variant={chatOpen ? "secondary" : "ghost"}
            size="sm"
            icon="sparkles"
            aria-label="Ask AI"
            onClick={onToggleChat}
          >
            <span className="max-md:sr-only">Ask AI</span>
          </Button>
          <Button aria-label="Run" variant="secondary" size="sm" icon="play" loading={runningNow} onClick={onTest}>
            <span className="max-md:sr-only">Run</span>
          </Button>
          <Button
            size="sm"
            icon="save"
            aria-label="Save"
            loading={saving}
            disabled={!dirty || conflict}
            onClick={onSave}
          >
            <span className="max-md:sr-only">Save</span>
          </Button>
          <Button aria-label="Publish" variant="secondary" size="sm" icon="check" disabled={blocking > 0 || dirty || conflict} onClick={onPublish}>
            <span className="max-md:sr-only">Publish</span>
          </Button>

          <div className="relative">
            <Button
              variant="ghost"
              size="sm"
              icon="menu"
              aria-label="More"
              onClick={() => setMenuOpen((o) => !o)}
            />
            {menuOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setMenuOpen(false)}
                  role="presentation"
                />
                <div className="absolute right-0 top-full z-20 mt-1 w-44 overflow-hidden rounded-card border border-line bg-card py-1 shadow-lg">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-danger transition-colors hover:bg-inset"
                  >
                    <Icon name="trash" size={14} />
                    Delete automation
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-2.5">
        <Switch
          checked={active}
          disabled={togglingActive}
          onChange={onToggleActive}
          label={
            <span
              className={cn(
                "text-[12.5px] font-semibold",
                active ? "text-success" : "text-ink-muted",
              )}
            >
              {active ? "Running" : "Paused"}
            </span>
          }
        />
        {wf?.trigger?.lastCheckedAt && (
          <span className="text-[12px] text-ink-subtle">
            Last checked {relTime(wf.trigger.lastCheckedAt)}
          </span>
        )}
        {/* A trigger that isn't firing looks identical to one whose event
            hasn't happened — unless it says why. */}
        {wf?.trigger?.error && (
          <span className="inline-flex items-center gap-1 text-[12px] text-warning" title={wf.trigger.error}>
            <Icon name="info" size={12} />
            {wf.trigger.error}
          </span>
        )}
        <span className="ml-auto text-[12px] text-ink-subtle">
          {wf ? `${wf.runs} run${wf.runs === 1 ? "" : "s"} · ${wf.success} success` : ""}
          {openRuns > 0 && <span className="text-brand"> · {openRuns} in flight</span>}
        </span>
      </div>
    </Card>
  );
}

function triggerLine(trigger: NonNullable<Workflow["trigger"]>): string {
  switch (trigger.kind) {
    case "event": {
      // "the moment it happens" is only true of a provider push. Composio also
      // delivers some trigger types by polling the account itself every couple
      // of minutes — fast, but not instant, and Gmail and Google Calendar are
      // both that. Saying so beats being caught out by a two-minute lag.
      const cadence =
        trigger.delivery === "realtime"
          ? trigger.deliveryChannel === "poll"
            ? "checks every few minutes"
            : "runs the moment it happens"
          : `checks ${(trigger.intervalMinutes ?? 60) >= 60 ? "hourly" : `every ${trigger.intervalMinutes} min`}`;
      // Naming the target makes the header say what is actually being watched.
      return `${trigger.label}${trigger.watching ? ` · ${trigger.watching}` : ""} · ${cadence}`;
    }
    case "schedule":
      return trigger.cadence ?? trigger.label;
    case "webhook":
      return "Starts when a webhook is received";
    default:
      return "Runs when you start it";
  }
}

function TabPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "rounded-full px-4 py-1.5 text-[13px] font-medium transition-colors",
        active ? "bg-card text-ink shadow-xs" : "text-ink-muted hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
