"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { Input } from "@/components/ui/form";
import { Dialog } from "@/components/ui/feedback";
import { useToast } from "@/components/ui/toast";
import { useCredits } from "@/components/ui/credits";
import { cn } from "@/lib/utils";
import type { Workflow } from "@/lib/data/workflows";
import { requestRun } from "@/lib/workflows/run-request";
import { requestWorkflowCreation } from "@/lib/workflows/create-request";
import {
  appOf,
  needsBrandGrounding,
  requiredAppsOf,
  unconnected,
  type RequiredApp,
} from "@/lib/workflows/apps";
import { appList, ConnectApps, useAppConnections } from "@/components/connect-apps";
import { BrandGap, useBrandReadiness } from "@/components/brand-readiness";
import { TEMPLATES, type WorkflowTemplate } from "@/lib/workflows/templates";
import type { ApprovalPreview as ApprovalPreviewData } from "@/lib/workflows/types";
import { ApprovalPreview } from "./approval-preview";
import { BuilderChat, type ChatSuggestion } from "./builder-chat";
import { WorkflowLogo } from "./workflow-logo";
import Loading from "./loading";

/**
 * Automations — four sub-tabs over one page.
 *
 *   Create a new one     the composer, full width, templates under it
 *   My workflows         everything you have built
 *   Runs history         every run, newest first
 *   Needs your attention the runs and triggers that are blocked on a person
 *
 * The split exists because these are four different questions ("make me a new
 * one", "what do I have", "what happened", "what is stuck") and the old single
 * screen answered them all at once, in one column, with the chat panel pinned
 * beside a list that had its own filters. Tabs also mean the attention count
 * is on screen from the first paint instead of behind a filter.
 */

/** List row shape — the base view plus the run-history enrichment the API adds. */
interface WorkflowListItem extends Workflow {
  createdAt: string;
  /** When it was last EDITED — what "Recently edited" is supposed to mean. */
  updatedAt: string | null;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  /** Runs still queued, running or waiting — deliberately not in the success rate. */
  openRuns: number;
  /** Runs blocked on a person's decision. */
  waitingRuns: number;
  /** Run statuses oldest→newest, up to 12. */
  recent: (string | null)[];
  /** Toolkit slug for the lead integration's logo, or null. */
  logo: string | null;
}

/** One run, from /api/workflows/runs — across every automation. */
interface RunItem {
  id: string;
  workflowId: string;
  workflowName: string;
  logo: string | null;
  status: "queued" | "running" | "waiting" | "completed" | "failed";
  label: string;
  startedAt: string;
  time: string;
  took: string | null;
  steps: number;
  error: string | null;
  /** `preview` is the content the decision is about — see lib/workflows/preview.ts. */
  pending: {
    stepId: string;
    prompt: string;
    preview?: ApprovalPreviewData | null;
  } | null;
  /** Set while the run is parked on machine work. Nobody has to do anything. */
  awaiting?: { kind: string; operation?: string; note: string; since: string } | null;
}

type TabId = "create" | "workflows" | "runs" | "attention";

/** "Live" / "Paused" / "Drafts" on My workflows. */
type WorkflowFilter = "all" | "live" | "paused" | "draft";
/** The run filters on Runs history. */
type RunFilter = "all" | "completed" | "failed" | "waiting";

const SUGGESTIONS: ChatSuggestion[] = [
  {
    icon: "message",
    label: "Google review auto-reply",
    desc: "Categorize each new review and post a fitting reply.",
    prompt:
      "Whenever a customer leaves a Google review, categorize it as positive, negative, or neutral, draft a fitting reply, and post it",
  },
  {
    icon: "database",
    label: "Weekly growth report",
    desc: "Summarize the week's numbers and post to Slack after approval.",
    prompt:
      "Every Monday summarize my growth metrics and post the summary to Slack #growth after I approve",
  },
  {
    icon: "send",
    label: "Daily LinkedIn post",
    desc: "Draft a founder-style post and publish once you approve.",
    prompt:
      "Draft a founder-style LinkedIn post about building an AI startup and publish it after I approve",
  },
  {
    icon: "zap",
    label: "Shopify order digest",
    desc: "Summarize new orders and email the highlights to you.",
    prompt: "Summarize my recent Shopify orders and email me the highlights",
  },
];

/**
 * The rotating examples in the empty composer.
 *
 * Deliberately not the same sentences as the suggestion cards below it: the
 * cards are four things you can click, these are a hint at the range of what
 * the box accepts — a trigger, a schedule, an approval, a digest.
 */
const PROMPT_HINTS = [
  "Reply to every new Google review in my voice…",
  "Every Monday, post last week's growth numbers to Slack…",
  "Draft a LinkedIn post each morning and publish it once I approve…",
  "Email me a digest whenever new Shopify orders come in…",
  "Watch for urgent GitHub issues and alert whoever is on call…",
];

/** The hand-built path is a real paused draft, not a special client-only canvas. */
const MANUAL_TEMPLATE = TEMPLATES.find((template) => template.id === "blank")!;

/**
 * Does this automation want a human?
 *
 * It used to mean "the last run failed" alone — which was defensible only
 * while `human_approval` was a hardcoded auto-approve and a run could never
 * actually stop. Now that approvals genuinely pause, a `waiting` run is the
 * single most attention-needing state there is: nothing in the system will
 * move it, ever, until somebody decides. A trigger that is erroring counts too
 * — an automation that silently cannot poll looks exactly like one whose event
 * simply hasn't happened.
 */
function needsAttention(w: WorkflowListItem): boolean {
  return (w.waitingRuns ?? 0) > 0 || w.lastRunStatus === "failed" || Boolean(w.trigger?.error);
}

/** Why it is in the list, most urgent first. */
function attentionReason(w: WorkflowListItem): string | null {
  if ((w.waitingRuns ?? 0) > 0) {
    return w.waitingRuns === 1
      ? "Waiting for your review"
      : `${w.waitingRuns} runs waiting for your review`;
  }
  if (w.lastRunStatus === "failed") return "The last run failed";
  if (w.trigger?.error) return w.trigger.error;
  return null;
}

/**
 * The decision endpoint executes the rest of the run in the request, and a long
 * automation can genuinely outlast the wait. Aborting the fetch does NOT abort
 * the run — it is journaled server-side and the next beat resumes it — so the
 * timeout message has to say that rather than "couldn't reach the server".
 * (Run itself goes through `requestRun`, which owns the same rule plus the
 * idempotency key that makes a second press safe.)
 */
const RUN_WAIT_MS = 310_000;
const stillRunning = (err: unknown) =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

/** A live automation with no runs yet is waiting for its trigger, not a draft. */
function isDraft(w: WorkflowListItem): boolean {
  return w.runs === 0 && !w.active;
}

export default function WorkflowsPage() {
  return <Suspense fallback={<Loading />}><WorkflowsContent /></Suspense>;
}

function WorkflowsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const { refresh: refreshCredits } = useCredits();

  const requestedTab = searchParams.get("tab");
  const tab: TabId = requestedTab === "workflows" || requestedTab === "runs" || requestedTab === "attention"
    ? requestedTab
    : "create";
  const [items, setItems] = useState<WorkflowListItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [runsError, setRunsError] = useState<string | null>(null);
  const query = searchParams.get("q") ?? "";
  const [wfFilter, setWfFilter] = useState<WorkflowFilter>("all");
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [creating, setCreating] = useState<string | null>(null);
  const [createdHref, setCreatedHref] = useState<string | null>(null);
  const [isOpening, startOpening] = useTransition();
  /** React state is not a mutex: this closes same-frame template clicks. */
  const creatingRef = useRef(false);
  /**
   * A template the user asked for that needs an account first.
   *
   * Templates used to create instantly and say nothing, so the first mention
   * of Shopify or GitHub was a failed run days later. Connection state is
   * fetched once for every template on the page (one request, not one per
   * card) and the dialog reuses it, so opening this is instant.
   */
  const [gated, setGated] = useState<WorkflowTemplate | null>(null);
  /**
   * What is in flight, keyed by the thing it acts on, valued by which action.
   *
   * A single busy id was wrong twice over: approving a run and re-running a
   * failed automation both take as long as the work itself (those endpoints
   * drive the run in-request), so one shared lock froze every other card for
   * the duration — and because the value was only an id, pressing Reject put
   * the spinner on the Approve button beside it.
   */
  const [busy, setBusy] = useState<Record<string, string>>({});
  const startBusy = (id: string, action: string) =>
    setBusy((b) => ({ ...b, [id]: action }));
  const endBusy = (id: string) =>
    setBusy((b) => {
      const next = { ...b };
      delete next[id];
      return next;
    });
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);

  function setTab(next: TabId) {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", next);
    // Workflow and run searches filter different things.
    params.delete("q");
    window.history.pushState(null, "", `/app/workflows?${params}`);
  }

  function setQuery(value: string) {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set("q", value);
    else params.delete("q");
    window.history.replaceState(null, "", `/app/workflows${params.size ? `?${params}` : ""}`);
  }

  /**
   * Load the list.
   *
   * A failed fetch used to `setItems([])`, which renders the "No automations
   * yet" empty state — so a server that was down, or a session that had
   * expired, told the user their automations did not exist. An error is now an
   * error, with a way to retry.
   */
  const load = useCallback(async () => {
    // Nothing is set before the first await, so mounting this doesn't cascade
    // a render (react-hooks/set-state-in-effect).
    try {
      const res = await fetch("/api/workflows");
      const data = (await res.json().catch(() => null)) as {
        workflows?: WorkflowListItem[];
        error?: string;
      } | null;
      if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}.`);
      setLoadError(null);
      setItems(data?.workflows ?? []);
    } catch (err) {
      setItems(null);
      setLoadError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  /**
   * Runs across every automation — the history tab and the waiting decisions.
   *
   * On failure it keeps whatever is already on screen and only records the
   * error: this is re-run every time one of those tabs is opened, and swapping
   * a good list for a full-page error because one background refresh failed is
   * worse than showing slightly old rows with a note saying so.
   */
  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/workflows/runs");
      const data = (await res.json().catch(() => null)) as {
        runs?: RunItem[];
        error?: string;
      } | null;
      if (!res.ok) throw new Error(data?.error ?? `The server answered ${res.status}.`);
      setRunsError(null);
      setRuns(data?.runs ?? []);
    } catch (err) {
      setRunsError(err instanceof Error ? err.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await load();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // Runs are fetched when one of the tabs that shows them is opened — the
  // create tab is the landing screen and has no use for 60 run rows — and
  // again on every re-open, because a run decided in another tab, or one that
  // finished while this page sat open, would otherwise show its old status
  // until a full reload.
  const wantsRuns = tab === "runs" || tab === "attention";
  useEffect(() => {
    if (!wantsRuns) return;
    let alive = true;
    void (async () => {
      await loadRuns();
      if (!alive) return;
    })();
    return () => {
      alive = false;
    };
  }, [wantsRuns, loadRuns]);

  /** Every account any template on this page touches — one status request. */
  const templateApps = useMemo(() => {
    const seen = new Map<string, RequiredApp>();
    for (const t of TEMPLATES) {
      for (const app of requiredAppsOf(t.graph)) seen.set(app.app, app);
    }
    return [...seen.values()];
  }, []);
  const { connections, busy: connectBusy, connect, resolve } = useAppConnections(templateApps);

  /** This template's accounts, in the order the template needs them. */
  const appsFor = useCallback(
    (template: WorkflowTemplate) => {
      const wanted = requiredAppsOf(template.graph);
      return wanted.map((app) => connections.find((c) => c.app === app.app) ?? { ...appOf(app.app), status: "unknown" as const });
    },
    [connections],
  );

  const gatedApps = gated ? appsFor(gated) : [];
  const gatedMissing = unconnected(gatedApps);
  const { readiness } = useBrandReadiness();

  /**
   * Templates create a real workflow and drop you straight into the editor —
   * once the accounts they run on are actually connected. Anything still
   * missing opens the connect dialog instead of creating a workflow that
   * cannot do its job.
   */
  async function startTemplate(
    template: WorkflowTemplate,
    openChat = false,
    skipConnectionCheck = false,
  ) {
    if (creatingRef.current || createdHref) return;
    creatingRef.current = true;
    setCreating(template.id);
    let keepLocked = false;
    try {
      // `resolve` waits for the first status fetch rather than answering
      // "unknown". The lock is already held while this await is pending.
      if (!skipConnectionCheck) {
        const apps = await resolve(requiredAppsOf(template.graph));
        if (unconnected(apps).length) {
          setGated(template);
          return;
        }
      }

      const outcome = await requestWorkflowCreation(`template:${template.id}`, {
        template: template.id,
      });
      if (outcome.kind === "unknown") {
        toast({
          title: "Couldn't confirm the creation",
          description: "Try again — the retry will not create a duplicate.",
          tone: "warning",
        });
        return;
      }
      if (outcome.kind === "refused") {
        toast({ title: "Couldn't create that", description: outcome.message, tone: "danger" });
        return;
      }

      setGated(null);
      const mode = openChat ? "?creating=1&chat=1" : "?creating=1";
      const href = `/app/workflows/${outcome.workflow.id}${mode}`;
      keepLocked = true;
      setCreatedHref(href);
      startOpening(() => router.push(href));
    } finally {
      if (!keepLocked) {
        creatingRef.current = false;
        setCreating(null);
      }
    }
  }

  const creationLocked = creating !== null || createdHref !== null;

  /**
   * The on/off switch on a workflow card.
   *
   * Switching ON is refused server-side while any step is still missing setup,
   * and that refusal is the useful half — it names what is unfinished — so it
   * is surfaced rather than swallowed into a generic failure.
   */
  async function toggleActive(wf: WorkflowListItem) {
    if (busy[wf.id]) return;
    startBusy(wf.id, "toggle");
    const next = !wf.active;
    try {
      const res = await fetch(`/api/workflows/${wf.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: next }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast({
          title: next ? "Couldn't switch it on" : "Couldn't pause it",
          description: data?.error,
          tone: "danger",
        });
        return;
      }
      setItems((prev) =>
        (prev ?? []).map((w) => (w.id === wf.id ? { ...w, active: next } : w)),
      );
      toast({ title: next ? `${wf.name} is live` : `${wf.name} is paused` });
    } catch {
      toast({ title: "Couldn't reach the server", tone: "danger" });
    } finally {
      endBusy(wf.id);
    }
  }

  /** Approve or reject a run that stopped for a person. */
  async function decide(run: RunItem, decision: "approve" | "reject") {
    if (busy[run.id]) return;
    startBusy(run.id, decision);
    try {
      const res = await fetch(`/api/workflows/${run.workflowId}/runs/${run.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(RUN_WAIT_MS),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        status?: string;
        alreadyResolved?: boolean;
      } | null;
      if (!res.ok) {
        toast({ title: "Couldn't record that", description: data?.error, tone: "danger" });
        return;
      }
      if (data?.alreadyResolved) {
        // Two tabs, or a beat that got there first. Not an error, but saying
        // "Approved" would claim this click did something it didn't.
        toast({
          title: "Already decided",
          description: "This run had already moved on. The list is up to date now.",
        });
      } else {
        toast({
          title: decision === "approve" ? "Approved" : "Rejected",
          description:
            data?.status === "failed"
              ? "The run resumed but then failed — open it to see where."
              : decision === "approve"
                ? "The run picked up where it stopped."
                : "The run was closed without publishing.",
          tone: data?.status === "failed" ? "danger" : undefined,
        });
      }
      // The decision finishes the run in-request, so both views are stale.
      await Promise.all([loadRuns(), load()]);
    } catch (err) {
      if (stillRunning(err)) {
        toast({
          title: "Still finishing",
          description: "Your decision was recorded — the run is being finished in the background.",
        });
        await Promise.all([loadRuns(), load()]);
      } else {
        toast({ title: "Couldn't reach the server", tone: "danger" });
      }
    } finally {
      endBusy(run.id);
    }
  }

  /** Run a failed automation once more, from the attention card. */
  async function runAgain(wf: { id: string; name: string }) {
    if (busy[wf.id]) return;
    startBusy(wf.id, "run");
    try {
      const outcome = await requestRun(wf.id);
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
        toast({ title: "Couldn't run it", description: outcome.message, tone: "danger" });
        return;
      }
      if (outcome.kind === "unknown") {
        // The endpoint drives the run inside the request and nginx cuts a
        // public request at 60s, so no answer is the NORMAL outcome for a long
        // automation — not a failure. Aborting the fetch doesn't abort the run
        // either: it is journaled server-side and finishes or resumes.
        toast({
          title: outcome.reason === "network" ? "Couldn't reach the server" : "Still running",
          description:
            outcome.reason === "network"
              ? "It may have started anyway — this list shows where it got to."
              : "It outlasted the wait. The run continues on the server — check back shortly.",
        });
      } else {
        const status = outcome.status;
        toast({
          title:
            status === "completed"
              ? `${wf.name} ran cleanly`
              : status === "waiting"
                ? "It stopped for your review"
                : status === "failed"
                  ? "It failed again"
                  : outcome.duplicate
                    ? "Already running"
                    : "It's running",
          description:
            outcome.error ??
            (outcome.duplicate && status === "running"
              ? "The run you started earlier is still going."
              : undefined),
          tone: status === "failed" ? "danger" : undefined,
        });
      }
      await Promise.all([loadRuns(), load()]);
    } finally {
      endBusy(wf.id);
    }
  }

  // Memoized so the three views below don't re-derive on every keystroke.
  const list = useMemo(() => items ?? [], [items]);

  /**
   * The estimate shown before the runs are fetched: every waiting run is its
   * own decision so they count individually, while a broken automation counts
   * once however many times it has failed. Once the runs land, the cards
   * themselves are the count — a badge that disagrees with the heading right
   * beneath it is worse than a badge that arrives a moment late.
   */
  const estimatedAttention = useMemo(
    () =>
      list.reduce(
        (n, w) =>
          n +
          (w.waitingRuns ?? 0) +
          (w.lastRunStatus === "failed" ? 1 : 0) +
          (w.trigger?.error ? 1 : 0),
        0,
      ),
    [list],
  );

  const visibleWorkflows = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = list;
    if (q) {
      out = out.filter(
        (w) => w.name.toLowerCase().includes(q) || w.desc.toLowerCase().includes(q),
      );
    }
    if (wfFilter === "live") out = out.filter((w) => w.active);
    if (wfFilter === "paused") out = out.filter((w) => !w.active && !isDraft(w));
    if (wfFilter === "draft") out = out.filter(isDraft);
    // Blocked-on-you first — those are the only ones that will never resolve
    // on their own — then most recently edited.
    return [...out].sort((a, b) => {
      const urgency = (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0);
      if (urgency) return urgency;
      return (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? "");
    });
  }, [list, query, wfFilter]);

  const visibleRuns = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = runs ?? [];
    if (q) out = out.filter((r) => r.workflowName.toLowerCase().includes(q));
    if (runFilter !== "all") {
      out =
        runFilter === "waiting"
          ? out.filter((r) => r.status === "waiting")
          : out.filter((r) => r.status === runFilter);
    }
    return out;
  }, [runs, query, runFilter]);

  /**
   * What is blocked on a person, most urgent first: decisions, then failures,
   * then triggers that cannot poll. A waiting run is one card per run — each
   * one is a separate decision — while a failing automation is one card.
   */
  const attention = useMemo(() => {
    const byId = new Map(list.map((w) => [w.id, w]));
    const out: AttentionItem[] = [];
    for (const run of runs ?? []) {
      // `waiting` covers two opposite situations. Only one of them is anybody's
      // business: a run parked on a video render is waiting for a machine that
      // will finish on its own, and putting it under "one thing is waiting on
      // you" would ask for a decision that does not exist.
      if (run.status !== "waiting" || run.awaiting || !run.pending) continue;
      const wf = byId.get(run.workflowId);
      if (wf) out.push({ kind: "waiting", wf, run });
    }
    for (const wf of list) {
      if (wf.lastRunStatus !== "failed") continue;
      const run = (runs ?? []).find((r) => r.workflowId === wf.id && r.status === "failed");
      out.push({ kind: "failed", wf, run });
    }
    for (const wf of list) {
      if (wf.trigger?.error) out.push({ kind: "trigger", wf });
    }
    return out;
  }, [list, runs]);

  const loading = items === null && !loadError;

  return (
    <div className="flex flex-col">
      <TabBar
        value={tab}
        onChange={setTab}
        counts={{
          workflows: list.length,
          attention: runs ? attention.length : estimatedAttention,
        }}
      />

      {/* No tabindex on these panels. Every one of them contains focusable
          content, so APG does not ask for one, and nothing focuses them in
          code — but tabindex="-1" makes a container click-focusable, so a
          click on empty panel background parked focus here and the next
          keypress (Cmd, Shift, anything) flipped it to :focus-visible and
          drew the page-wide focus ring. */}
      {tab === "create" && (
        <div className="pt-6" role="tabpanel" id="tabpanel-create" aria-labelledby="tab-create">
          <BuilderChat
            variant="hero"
            placeholder="Describe the automation you want"
            placeholders={PROMPT_HINTS}
            suggestions={SUGGESTIONS}
            context="list"
            inputRef={chatInputRef}
            navigationPending={createdHref !== null}
            onSaved={(workflow) => {
              const href = `/app/workflows/${workflow.id}?creating=1`;
              setCreatedHref(href);
              startOpening(() => router.push(href));
            }}
          />

          {createdHref && (
            <div
              role="status"
              className="mx-auto mt-4 flex w-fit items-center gap-2 rounded-full border border-brand-border bg-brand-subtle px-4 py-2 text-[13px] text-ink"
            >
              <Icon name="refresh" size={14} className={isOpening ? "animate-spin text-brand" : "text-brand"} />
              <span>{isOpening ? "Opening automation…" : "Automation saved."}</span>
              <Link href={createdHref} className="font-semibold text-brand hover:underline">
                Open automation
              </Link>
            </div>
          )}

          <div
            data-create-manually
            className="mx-auto mt-5 flex w-fit flex-wrap items-center justify-center gap-2.5 text-[13px] text-ink-subtle"
          >
            <span>Prefer to build step by step?</span>
            <Button
              variant="secondary"
              size="sm"
              icon="workflow"
              loading={creating === MANUAL_TEMPLATE.id}
              disabled={creationLocked}
              onClick={() => void startTemplate(MANUAL_TEMPLATE, true)}
            >
              Create manually
            </Button>
          </div>

          <div className="mx-auto mt-9 w-full max-w-[1080px]">
            <div className="flex items-center gap-4">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[13px] font-semibold text-ink-subtle">
                Or start from a template
              </span>
              <span className="h-px flex-1 bg-line" />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {TEMPLATES.filter((template) => template.id !== MANUAL_TEMPLATE.id).map((t) => (
                <button
                  key={t.id}
                  disabled={creationLocked}
                  onClick={() => void startTemplate(t)}
                  className="group flex flex-col gap-2.5 rounded-card border border-line bg-card p-4 text-left shadow-xs transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:border-brand-border hover:shadow-md disabled:pointer-events-none disabled:opacity-60"
                >
                  <span className="flex items-center gap-2">
                    <WorkflowLogo logo={t.app ?? null} />
                    {creating === t.id && (
                      <Icon name="refresh" size={14} className="animate-spin text-ink-subtle" />
                    )}
                  </span>
                  <span className="text-[14.5px] font-semibold leading-tight tracking-[-0.01em] text-ink">
                    {t.name}
                  </span>
                  <span className="flex-1 text-[13px] leading-snug text-ink-subtle">
                    {t.description}
                  </span>
                  <span className="flex items-center gap-1.5 text-[13px] font-semibold text-brand opacity-0 transition-opacity group-hover:opacity-100">
                    Use this
                    <Icon name="arrow-right" size={14} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {tab === "workflows" && (
        <div className="mx-auto w-full max-w-[1080px] pt-9" role="tabpanel" id="tabpanel-workflows" aria-labelledby="tab-workflows">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[220px] flex-1">
              <Input
                leftIcon="search"
                placeholder="Search your automations"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="rounded-full"
              />
            </div>
            <FilterPills
              value={wfFilter}
              onChange={(v) => setWfFilter(v as WorkflowFilter)}
              items={[
                { id: "all", label: "All" },
                { id: "live", label: "Live" },
                { id: "paused", label: "Paused" },
                { id: "draft", label: "Drafts" },
              ]}
            />
            <Button
              className="rounded-full"
              variant="secondary"
              icon="workflow"
              loading={creating === MANUAL_TEMPLATE.id}
              disabled={creationLocked}
              onClick={() => void startTemplate(MANUAL_TEMPLATE, true)}
            >
              Add manually
            </Button>
            <Button
              className="rounded-full"
              icon="plus"
              disabled={creationLocked}
              onClick={() => {
                setTab("create");
                // Land in the box, not just on the screen.
                window.setTimeout(() => chatInputRef.current?.focus(), 0);
              }}
            >
              New automation
            </Button>
          </div>

          <div className="mt-5">
            {loadError ? (
              <ErrorState message={loadError} onRetry={() => void load()} />
            ) : loading ? (
              <div className="grid gap-3.5 md:grid-cols-2">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-[132px] animate-pulse rounded-card bg-inset" />
                ))}
              </div>
            ) : list.length === 0 ? (
              <EmptyState
                icon="sparkles"
                title="No automations yet"
                body="Describe one in the composer, or start from a template — both land in the same editor."
                action={<Button onClick={() => setTab("create")}>Create your first one</Button>}
              />
            ) : visibleWorkflows.length === 0 ? (
              <EmptyState icon="search" title="Nothing matches here" body="Try a different search or filter." />
            ) : (
              <div className="grid gap-3.5 md:grid-cols-2">
                {visibleWorkflows.map((wf) => (
                  <WorkflowCard
                    key={wf.id}
                    wf={wf}
                    busy={Boolean(busy[wf.id])}
                    onOpen={() => router.push(`/app/workflows/${wf.id}`)}
                    onToggle={() => void toggleActive(wf)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "runs" && (
        <div className="mx-auto w-full max-w-[880px] pt-9" role="tabpanel" id="tabpanel-runs" aria-labelledby="tab-runs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-[220px] flex-1">
              <Input
                leftIcon="search"
                placeholder="Search runs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="rounded-full"
              />
            </div>
            <FilterPills
              value={runFilter}
              onChange={(v) => setRunFilter(v as RunFilter)}
              items={[
                { id: "all", label: "All" },
                { id: "completed", label: "Succeeded" },
                { id: "failed", label: "Failed" },
                { id: "waiting", label: "Waiting" },
              ]}
            />
          </div>

          <div className="mt-6">
            {runsError && runs !== null && <StaleNote onRetry={() => void loadRuns()} />}
            {runsError && runs === null ? (
              <ErrorState message={runsError} onRetry={() => void loadRuns()} />
            ) : runs === null ? (
              <div className="flex flex-col gap-2">
                {[0, 1, 2, 3, 4].map((i) => (
                  <div key={i} className="h-[62px] animate-pulse rounded-card bg-inset" />
                ))}
              </div>
            ) : runs.length === 0 ? (
              <EmptyState
                icon="activity"
                title="No runs yet"
                body="Switch an automation on, or press Run inside one, and every run shows up here."
              />
            ) : visibleRuns.length === 0 ? (
              <EmptyState icon="filter" title="Nothing matches here" body="Try a different search or filter." />
            ) : (
              <RunTimeline runs={visibleRuns} onOpen={(r) => router.push(`/app/workflows/${r.workflowId}`)} />
            )}
          </div>
        </div>
      )}

      {tab === "attention" && (
        <div className="mx-auto w-full max-w-[820px] pt-9" role="tabpanel" id="tabpanel-attention" aria-labelledby="tab-attention">
          {runsError && runs !== null && <StaleNote onRetry={() => void loadRuns()} />}
          {loadError && items === null ? (
            <ErrorState message={loadError} onRetry={() => void load()} />
          ) : runsError && runs === null ? (
            <ErrorState message={runsError} onRetry={() => void loadRuns()} />
          ) : items === null || runs === null ? (
            <div className="flex flex-col gap-3.5">
              {[0, 1].map((i) => (
                <div key={i} className="h-[200px] animate-pulse rounded-[18px] bg-inset" />
              ))}
            </div>
          ) : attention.length === 0 ? (
            <EmptyState
              icon="check"
              title="Nothing is waiting on you"
              body="Every automation is running on its own. Anything that stops for a decision — or breaks — shows up here."
            />
          ) : (
            <>
              <div className="text-center">
                <h2 className="font-display text-[26px] font-semibold tracking-[-0.025em] text-ink">
                  {attention.length === 1
                    ? "One thing is waiting on you"
                    : `${attention.length} things are waiting on you`}
                </h2>
                <p className="mt-2 text-[15px] text-ink-subtle">
                  Nothing here moves until you decide. Clear them and everything runs on its own again.
                </p>
              </div>

              <div className="mt-7 flex flex-col gap-3.5">
                {attention.map((item, i) => (
                  <AttentionCard
                    key={item.kind === "waiting" ? item.run.id : `${item.kind}-${item.wf.id}`}
                    item={item}
                    lead={i === 0}
                    // Which action is running on THIS card, so the spinner
                    // lands on the button that was pressed and the rest of the
                    // page stays usable while a long run finishes.
                    running={busy[item.kind === "waiting" ? item.run.id : item.wf.id]}
                    onOpen={() => router.push(`/app/workflows/${item.wf.id}`)}
                    onDecide={(decision) =>
                      item.kind === "waiting" ? void decide(item.run, decision) : undefined
                    }
                    onRunAgain={() => void runAgain(item.wf)}
                    onReconnect={() => router.push("/app/integrations")}
                  />
                ))}
              </div>

              <p className="mt-5 text-center text-[12.5px] text-ink-subtle">
                Approvals expire after 30 days.
              </p>
            </>
          )}
        </div>
      )}

      {/* Asked for BEFORE the automation exists, because an automation whose
          accounts are missing is not a draft — it is a thing that fails on its
          first run, at the first step that needs the account, with the whole
          graph already built and switched on. */}
      <Dialog
        open={gated !== null}
        onClose={() => setGated(null)}
        title="Connect your accounts first"
        subtitle={
          gated
            ? `“${gated.name}” runs on ${appList(gatedApps)}. Connect what's missing and it's ready to build.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setGated(null)}>
              Cancel
            </Button>
            <Button
              icon="plus"
              loading={creating === gated?.id}
              disabled={gatedMissing.length > 0}
              onClick={() => gated && void startTemplate(gated, false, true)}
            >
              {gatedMissing.length > 0 ? `Waiting on ${appList(gatedMissing)}` : "Create automation"}
            </Button>
          </>
        }
      >
        <ConnectApps
          connections={gatedApps}
          busy={connectBusy}
          onConnect={connect}
          title="Accounts this template uses"
          note="Each provider opens in a new tab and returns you here. Your automation stays safely paused until every connection is ready."
        />
        {/* Only reachable when an account is ALSO missing, since a template
            whose accounts are all connected is created without stopping here.
            That path lands straight in the editor, which raises the same
            notice — so nobody builds one of these unwarned, they just hear it
            one screen later. */}
        <BrandGap
          className="mt-3 flex items-start gap-2 rounded-card border border-warning-border bg-warning-surface px-3.5 py-3"
          readiness={readiness}
          needed={!!gated && needsBrandGrounding(gated.graph)}
        />
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

const TABS: { id: TabId; label: string }[] = [
  { id: "create", label: "Create a new one" },
  { id: "workflows", label: "My workflows" },
  { id: "runs", label: "Runs history" },
  { id: "attention", label: "Needs your attention" },
];

/**
 * The four sub-tabs, centered.
 *
 * Centered rather than left-aligned under a page title because this page has
 * no title — the tab you are on is the title, and the composer beneath it is
 * the first thing the eye should land on.
 */
function TabBar({
  value,
  onChange,
  counts,
}: {
  value: TabId;
  onChange: (id: TabId) => void;
  counts: { workflows: number; attention: number };
}) {
  return (
    <div className="flex justify-center">
      <div
        role="tablist"
        aria-label="Automations"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-full border border-line bg-inset p-1"
      >
        {TABS.map((t, i) => {
          const active = t.id === value;
          const count =
            t.id === "workflows"
              ? counts.workflows
              : t.id === "attention"
                ? counts.attention
                : 0;
          return (
            <button
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={active}
              aria-controls={`tabpanel-${t.id}`}
              // Roving tabindex: one stop for the whole set, arrows move
              // within it. Declaring role="tablist" and then leaving the
              // arrow keys dead is the half-built version of this.
              tabIndex={active ? 0 : -1}
              onKeyDown={(e) => {
                const delta =
                  e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                let next = -1;
                if (delta) next = (i + delta + TABS.length) % TABS.length;
                else if (e.key === "Home") next = 0;
                else if (e.key === "End") next = TABS.length - 1;
                if (next < 0) return;
                e.preventDefault();
                onChange(TABS[next].id);
                document.getElementById(`tab-${TABS[next].id}`)?.focus();
              }}
              onClick={() => onChange(t.id)}
              className={cn(
                "flex flex-none items-center gap-2 rounded-full px-4 py-2 text-[14px] transition-all duration-150",
                active
                  ? "bg-card font-semibold text-ink shadow-sm"
                  : "font-medium text-ink-subtle hover:text-ink",
              )}
            >
              {t.label}
              {count > 0 && (
                <span
                  className={cn(
                    "min-w-[19px] rounded-full px-1.5 py-0.5 text-[11px] font-bold leading-none text-on-brand",
                    // The attention badge is the one number on this page that
                    // means "act", so it never blends in with the neutral one.
                    t.id === "attention"
                      ? "bg-danger"
                      : active
                        ? "bg-brand"
                        : "bg-line-strong",
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FilterPills({
  value,
  onChange,
  items,
}: {
  value: string;
  onChange: (id: string) => void;
  items: { id: string; label: string }[];
}) {
  return (
    <div className="flex flex-none flex-wrap gap-1.5">
      {items.map((it) => {
        const active = it.id === value;
        return (
          <button
            key={it.id}
            onClick={() => onChange(it.id)}
            className={cn(
              "h-10 rounded-full border px-3.5 text-[13.5px] font-medium transition-colors",
              active
                ? "border-brand-border bg-brand-subtle text-brand"
                : "border-line bg-card text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: IconName;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <Card className="px-8 py-16 text-center">
      <Icon name={icon} size={26} className="mx-auto mb-3 text-ink-subtle" />
      <div className="text-[15px] font-semibold text-ink">{title}</div>
      <p className="mx-auto mt-1.5 max-w-[440px] text-[13.5px] leading-relaxed text-ink-subtle">
        {body}
      </p>
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </Card>
  );
}

/** A refresh failed but there is still something on screen worth showing. */
function StaleNote({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="mb-3 flex items-center gap-2 rounded-card border border-warning-border bg-warning-surface px-3.5 py-2.5 text-[13px] text-warning">
      <Icon name="info" size={15} className="flex-none" />
      Couldn&apos;t refresh — showing what was last loaded.
      <button onClick={onRetry} className="ml-auto font-semibold underline underline-offset-2">
        Try again
      </button>
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="px-8 py-16 text-center">
      <Icon name="info" size={26} className="mx-auto mb-3 text-danger" />
      <div className="text-[15px] font-semibold text-ink">Couldn&apos;t load that</div>
      <p className="mt-1.5 text-[13.5px] text-ink-subtle">{message}</p>
      <Button className="mt-5" onClick={onRetry}>
        Try again
      </Button>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// My workflows
// ---------------------------------------------------------------------------

function WorkflowCard({
  wf,
  busy,
  onOpen,
  onToggle,
}: {
  wf: WorkflowListItem;
  busy: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  const reason = attentionReason(wf);
  const blocked = (wf.waitingRuns ?? 0) > 0;
  const failing = !blocked && (wf.lastRunStatus === "failed" || Boolean(wf.trigger?.error));
  const draft = isDraft(wf);

  return (
    <div
      className={cn(
        "relative flex flex-col overflow-hidden rounded-card border border-line bg-card p-4 shadow-xs",
        "transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-0.5 hover:shadow-md",
        // A left edge, so a card that wants something is findable in a grid
        // without reading any of them.
        blocked && "border-l-[3px] border-l-brand",
        failing && "border-l-[3px] border-l-danger",
      )}
    >
      {/* The whole card opens the editor; the switch sits above it. Nesting a
          real button inside a button is invalid, so the hit area is a sibling
          underneath and the content simply doesn't take clicks. */}
      <button
        onClick={onOpen}
        aria-label={`Open ${wf.name}`}
        className="absolute inset-0 rounded-card focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring"
      />

      <div className="pointer-events-none relative flex items-start gap-3">
        <WorkflowLogo logo={wf.logo} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] font-semibold tracking-[-0.015em] text-ink">
            {wf.name}
          </div>
          <div className="mt-0.5 line-clamp-2 text-[13px] leading-snug text-ink-subtle">
            {wf.desc || wf.schedule}
          </div>
        </div>
        <Toggle
          on={wf.active}
          busy={busy}
          label={wf.active ? `Pause ${wf.name}` : `Switch ${wf.name} on`}
          onClick={onToggle}
        />
      </div>

      <div className="pointer-events-none relative mt-4 flex items-center gap-3 border-t border-line pt-3.5 text-[12.5px] text-ink-subtle">
        {reason ? (
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold",
              blocked ? "bg-brand-subtle text-brand" : "bg-danger-surface text-danger",
            )}
          >
            <Icon name={blocked ? "hand" : "info"} size={12} />
            <span className="max-w-[190px] truncate">{reason}</span>
          </span>
        ) : draft ? (
          <span className="rounded-full bg-inset px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted">
            Draft
          </span>
        ) : wf.active ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-success-surface px-2.5 py-1 text-[11.5px] font-semibold text-success">
            <Icon name="check" size={12} />
            Live
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-inset px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted">
            <Icon name="pause" size={12} />
            Paused
          </span>
        )}

        <span className="ml-auto whitespace-nowrap">
          <b className="font-semibold tabular-nums text-ink">{wf.runs}</b> runs
        </span>
        <span className="whitespace-nowrap">{wf.lastRunAt ? wf.lastRun : "never run"}</span>
      </div>
    </div>
  );
}

/** The live switch. Not a checkbox because it acts on press, not on submit. */
function Toggle({
  on,
  busy,
  label,
  onClick,
}: {
  on: boolean;
  busy: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={busy}
      onClick={onClick}
      className={cn(
        "pointer-events-auto relative h-[21px] w-9 flex-none rounded-full transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
        on ? "bg-success" : "bg-line-strong",
        busy && "opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute top-[2px] h-[17px] w-[17px] rounded-full bg-card shadow-xs transition-[left] duration-200",
          on ? "left-[18px]" : "left-[2px]",
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Runs history
// ---------------------------------------------------------------------------

const RUN_TONE: Record<RunItem["status"], string> = {
  completed: "bg-success",
  failed: "bg-danger",
  waiting: "bg-brand",
  running: "bg-indigo-400",
  queued: "bg-line-strong",
};

/** Today / Yesterday / Earlier, from the run's own start time. */
function dayBucket(iso: string): string {
  const started = new Date(iso);
  if (Number.isNaN(started.getTime())) return "Earlier";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  if (started.getTime() >= midnight.getTime()) return "Today";
  if (started.getTime() >= midnight.getTime() - 86_400_000) return "Yesterday";
  return "Earlier";
}

function RunTimeline({ runs, onOpen }: { runs: RunItem[]; onOpen: (r: RunItem) => void }) {
  // Runs arrive newest first, so the buckets come out in order for free.
  const groups: { label: string; runs: RunItem[] }[] = [];
  for (const run of runs) {
    const label = dayBucket(run.startedAt);
    const last = groups[groups.length - 1];
    if (last?.label === label) last.runs.push(run);
    else groups.push({ label, runs: [run] });
  }

  return (
    <div className="relative pl-[34px]">
      <span className="absolute bottom-1.5 left-[14px] top-1.5 w-px bg-line" />
      {groups.map((group, gi) => (
        <div key={group.label}>
          <div
            className={cn(
              "-ml-[34px] mb-3 pl-[34px] text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-subtle",
              gi === 0 ? "mt-0" : "mt-7",
            )}
          >
            {group.label}
          </div>
          <div className="flex flex-col gap-2">
            {group.runs.map((run) => (
              <button
                key={run.id}
                onClick={() => onOpen(run)}
                className="relative flex items-center gap-3.5 rounded-card border border-line bg-card px-4 py-3 text-left transition-[border-color,transform] duration-150 hover:translate-x-0.5 hover:border-line-strong"
              >
                <span
                  className={cn(
                    "absolute -left-[27px] top-1/2 h-[11px] w-[11px] -translate-y-1/2 rounded-full border-[2.5px] border-page",
                    RUN_TONE[run.status],
                  )}
                />
                <WorkflowLogo logo={run.logo} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-ink">
                    {run.workflowName}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block truncate text-[12.5px]",
                      run.error ? "text-danger" : "text-ink-subtle",
                    )}
                  >
                    {run.error
                      ? run.error
                      : run.status === "waiting"
                        ? run.awaiting
                          ? `${run.awaiting.note} It resumes on its own.`
                          : "Paused — waiting for your review"
                        : run.status === "running" || run.status === "queued"
                          ? run.label
                          : `${run.steps} step${run.steps === 1 ? "" : "s"}${run.took ? ` · ${run.took}` : ""}`}
                  </span>
                </span>
                <span className="flex-none whitespace-nowrap text-[12.5px] text-ink-subtle">
                  {run.time}
                </span>
                <Icon name="chevron-right" size={16} className="flex-none text-ink-subtle" />
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Needs your attention
// ---------------------------------------------------------------------------

type AttentionItem =
  | { kind: "waiting"; wf: WorkflowListItem; run: RunItem }
  | { kind: "failed"; wf: WorkflowListItem; run?: RunItem }
  | { kind: "trigger"; wf: WorkflowListItem };

function AttentionCard({
  item,
  lead,
  running,
  onOpen,
  onDecide,
  onRunAgain,
  onReconnect,
}: {
  item: AttentionItem;
  /** The first card is the one to deal with — it gets the ring. */
  lead: boolean;
  /** "approve" | "reject" | "run" while that action is in flight on this card. */
  running?: string;
  onOpen: () => void;
  onDecide: (decision: "approve" | "reject") => void;
  onRunAgain: () => void;
  onReconnect: () => void;
}) {
  const anyRunning = Boolean(running);
  const waiting = item.kind === "waiting";
  const title =
    item.kind === "waiting"
      ? "Waiting for your review"
      : item.kind === "failed"
        ? "The last run failed"
        : "The trigger can't check for new events";
  const detail =
    item.kind === "waiting"
      ? item.run.pending?.prompt || "This run stopped for your approval before going any further."
      : item.kind === "failed"
        ? (item.run?.error ??
          "The run stopped before it finished. Open it to see which step, and what it said.")
        : (item.wf.trigger?.error ?? "");
  const when =
    item.kind === "waiting"
      ? `Held ${item.run.time}`
      : item.kind === "failed" && item.run
        ? `Failed ${item.run.time}`
        : item.wf.lastRunAt
          ? `Last checked ${item.wf.lastRun}`
          : "";

  return (
    <div
      className={cn(
        "rounded-[18px] border bg-card p-5 shadow-sm",
        lead
          ? "border-brand-border ring-4 ring-brand-border"
          : "border-line",
      )}
    >
      <div className="flex items-center gap-3">
        <WorkflowLogo logo={item.wf.logo} />
        <div className="min-w-0 flex-1">
          <div className="text-[16px] font-semibold tracking-[-0.015em] text-ink">{title}</div>
          <div className="mt-0.5 truncate text-[12.5px] text-ink-subtle">
            {item.wf.name}
            {when && ` · ${when}`}
          </div>
        </div>
        <span
          className={cn(
            "flex-none rounded-full px-2.5 py-1 text-[11.5px] font-semibold",
            waiting ? "bg-brand-subtle text-brand" : "bg-danger-surface text-danger",
          )}
        >
          {waiting ? "Waiting on you" : "Broken"}
        </span>
      </div>

      {detail && (
        <div
          className={cn(
            "mt-4 rounded-[12px] border px-4 py-3.5 text-[14px] leading-relaxed",
            waiting
              ? "border-line bg-sunken text-ink-muted"
              : "border-danger-border bg-danger-surface text-danger",
          )}
        >
          {detail}
        </div>
      )}

      {/* The whole point of the card: what "Approve" would actually send. It
          sits above the buttons because a decision offered before its subject
          is a decision made without one. */}
      {item.kind === "waiting" && item.run.pending?.preview && (
        <ApprovalPreview preview={item.run.pending.preview} className="mt-4" />
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {item.kind === "waiting" ? (
          <>
            <Button
              size="sm"
              icon="check"
              loading={running === "approve"}
              disabled={anyRunning}
              onClick={() => onDecide("approve")}
            >
              Approve
            </Button>
            <Button size="sm" variant="secondary" disabled={anyRunning} onClick={onOpen}>
              Open the automation
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:bg-danger-surface hover:text-danger"
              loading={running === "reject"}
              disabled={anyRunning}
              onClick={() => onDecide("reject")}
            >
              Reject
            </Button>
            {anyRunning && (
              <span className="text-[12.5px] text-ink-subtle">
                Finishing the run — this can take a moment.
              </span>
            )}
          </>
        ) : item.kind === "failed" ? (
          <>
            <Button
              size="sm"
              icon="refresh"
              loading={running === "run"}
              disabled={anyRunning}
              onClick={onRunAgain}
            >
              Run it again
            </Button>
            <Button size="sm" variant="secondary" disabled={anyRunning} onClick={onOpen}>
              See what happened
            </Button>
            {anyRunning && (
              <span className="text-[12.5px] text-ink-subtle">
                Running every step — this can take a moment.
              </span>
            )}
          </>
        ) : (
          <>
            <Button size="sm" icon="plug" onClick={onReconnect}>
              Check the connection
            </Button>
            <Button size="sm" variant="secondary" onClick={onOpen}>
              Open the automation
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
