"use client";

import {
  Activity,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  Filter,
  GitBranch,
  Inbox,
  Loader2,
  Play,
  Plus,
  Search,
  Send,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { INTEGRATION_BY_SLUG } from "@/lib/integrations/catalog";
import type { WorkflowTemplate } from "@/lib/workflows/templates";
import { ServiceIcon } from "@/components/service-icon";

export type AutomationListItem = {
  id: string;
  name: string;
  description: string;
  state: "active" | "paused" | "draft";
  updatedAt: string;
  lastRunAt: string | null;
  apps: string[];
};

export type AutomationRunItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  status: "succeeded" | "waiting" | "failed" | "running" | "queued";
  trigger: string;
  startedAt: string;
  duration: string;
  credits: number;
  error?: string | null;
};

export type AutomationApprovalItem = {
  id: string;
  workflowId: string;
  workflowName: string;
  prompt: string;
  preview: unknown;
  requestedAt: string;
};

type TabId = "create" | "workflows" | "runs" | "attention";
type WorkflowFilter = "all" | "active" | "paused" | "draft";
type RunFilter = "all" | "succeeded" | "failed" | "waiting";

const tabs: Array<{ id: TabId; label: string }> = [
  { id: "create", label: "Create a new one" },
  { id: "workflows", label: "My workflows" },
  { id: "runs", label: "Runs history" },
  { id: "attention", label: "Needs your attention" },
];

const suggestions = [
  {
    icon: Inbox,
    title: "Important email to Slack",
    description: "Summarize priority messages and route them to the right channel.",
    prompt: "When an important Gmail arrives, summarize it and post it to the right Slack channel after I approve",
  },
  {
    icon: Activity,
    title: "Weekly growth report",
    description: "Turn pipeline movement into one useful Monday update.",
    prompt: "Every Monday summarize my HubSpot pipeline changes and send the report to Slack after I approve",
  },
  {
    icon: Send,
    title: "WhatsApp order alert",
    description: "Send a concise operations alert for every Shopify order.",
    prompt: "When a Shopify order arrives, format the important details and send an approved WhatsApp alert",
  },
  {
    icon: GitBranch,
    title: "Urgent issue triage",
    description: "Classify new issues and escalate only urgent cases.",
    prompt: "Classify every new GitHub issue and post urgent ones to Slack after I approve",
  },
];

const rotatingHints = [
  "Reply to every new customer review in my voice…",
  "Every Monday, post last week's growth numbers to Slack…",
  "Draft a LinkedIn post and publish it once I approve…",
  "Send a WhatsApp alert whenever a Shopify order arrives…",
];

export function AutomationHub({
  workflows,
  runs,
  approvals: initialApprovals,
  templates,
}: {
  workflows: AutomationListItem[];
  runs: AutomationRunItem[];
  approvals: AutomationApprovalItem[];
  templates: WorkflowTemplate[];
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [tab, setTab] = useState<TabId>("create");
  const [prompt, setPrompt] = useState("");
  const [query, setQuery] = useState("");
  const [workflowFilter, setWorkflowFilter] = useState<WorkflowFilter>("all");
  const [runFilter, setRunFilter] = useState<RunFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [approvals, setApprovals] = useState(initialApprovals);

  const filteredWorkflows = useMemo(() => workflows.filter((item) => {
    const matchesQuery = `${item.name} ${item.description} ${item.apps.join(" ")}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (workflowFilter === "all" || item.state === workflowFilter);
  }), [query, workflowFilter, workflows]);

  const filteredRuns = useMemo(() => runs.filter((item) => {
    const matchesQuery = `${item.workflowName} ${item.trigger} ${item.status}`.toLowerCase().includes(query.toLowerCase());
    return matchesQuery && (runFilter === "all" || item.status === runFilter);
  }), [query, runFilter, runs]);

  const failures = runs.filter((run) => run.status === "failed");
  const attentionCount = approvals.length + failures.length;

  function selectTab(next: TabId) {
    setTab(next);
    setQuery("");
    setNotice("");
  }

  async function build(raw = prompt) {
    const value = raw.trim();
    if (!value || busy) return;
    setBusy("ai");
    setNotice("");
    try {
      const draftResponse = await fetch("/api/workflows/draft", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: value }),
      });
      const draft = await draftResponse.json() as { graph?: unknown; error?: string };
      if (!draftResponse.ok || !draft.graph) throw new Error(draft.error ?? "Automata could not design that workflow.");
      const createResponse = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: value.slice(0, 80), description: value, graph: draft.graph }),
      });
      const created = await createResponse.json() as { workflow?: { id: string }; error?: string };
      if (!createResponse.ok || !created.workflow) throw new Error(created.error ?? "The workflow could not be saved.");
      router.push(`/app/workflows/${created.workflow.id}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The workflow could not be created.");
    } finally {
      setBusy(null);
    }
  }

  async function instantiateTemplate(template: WorkflowTemplate) {
    if (busy) return;
    setBusy(template.id);
    setNotice("");
    try {
      const response = await fetch("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ templateId: template.id }),
      });
      const body = await response.json() as { workflow?: { id: string }; error?: string };
      if (!response.ok || !body.workflow) throw new Error(body.error ?? "Template could not be created.");
      router.push(`/app/workflows/${body.workflow.id}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Template could not be created.");
      setBusy(null);
    }
  }

  async function decide(id: string, decision: "approved" | "rejected") {
    if (id.startsWith("preview-")) {
      setNotice("Connect Supabase to make approval decisions.");
      return;
    }
    setBusy(`${id}-${decision}`);
    setNotice("");
    try {
      const response = await fetch(`/api/approvals/${id}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "That decision could not be saved.");
      setApprovals((items) => items.filter((item) => item.id !== id));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That decision could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="automation-hub">
      <AutomationTabs value={tab} workflowCount={workflows.length} attentionCount={attentionCount} onChange={selectTab} />

      {notice ? <div className="automation-notice" role="status"><TriangleAlert size={15} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div> : null}

      {tab === "create" ? (
        <section className="automation-create" role="tabpanel" aria-labelledby="automation-tab-create">
          <div className="automation-hero">
            <span className="automation-ai-mark"><Sparkles size={22} /></span>
            <h1>What should run itself?</h1>
            <p>Describe it in plain English. Nothing goes live until you publish it.</p>
            <div className="automation-composer">
              <textarea
                ref={inputRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void build();
                  }
                }}
                aria-label="Describe the automation you want"
                placeholder={rotatingHints[0]}
                rows={2}
              />
              <div><span><kbd>Enter</kbd> to build</span><button disabled={!prompt.trim() || busy !== null} onClick={() => void build()}>{busy === "ai" ? <Loader2 className="spin" size={17} /> : <ArrowRight size={17} />}</button></div>
            </div>
            <div className="automation-suggestions">
              {suggestions.map((item) => <button key={item.title} onClick={() => { setPrompt(item.prompt); void build(item.prompt); }} disabled={busy !== null}><i><item.icon size={17} /></i><span><b>{item.title}</b><small>{item.description}</small></span></button>)}
            </div>
          </div>

          <div className="template-divider"><span />Or start from a template<span /></div>
          <div className="automation-template-grid">
            {templates.slice(0, 9).map((template) => (
              <button className="automation-template-card" key={template.id} onClick={() => void instantiateTemplate(template)} disabled={busy !== null}>
                <AppStack apps={template.apps} />
                <b>{template.name}</b>
                <p>{template.description}</p>
                <span>{Object.keys(template.graph.steps).length} steps · {template.setupMinutes} min setup</span>
                <em>{busy === template.id ? <><Loader2 className="spin" size={13} />Creating</> : <>Use this <ArrowRight size={13} /></>}</em>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {tab === "workflows" ? (
        <section className="automation-panel" role="tabpanel" aria-labelledby="automation-tab-workflows">
          <div className="automation-toolbar">
            <SearchBox value={query} onChange={setQuery} placeholder="Search your automations" />
            <FilterPills value={workflowFilter} onChange={(value) => setWorkflowFilter(value as WorkflowFilter)} items={["all", "active", "paused", "draft"]} />
            <button className="automation-primary" onClick={() => { selectTab("create"); window.setTimeout(() => inputRef.current?.focus(), 0); }}><Plus size={16} />New automation</button>
          </div>
          {filteredWorkflows.length ? <div className="workflow-card-grid">{filteredWorkflows.map((workflow) => <WorkflowCard workflow={workflow} onOpen={() => router.push(`/app/workflows/${workflow.id}`)} key={workflow.id} />)}</div> : <EmptyState icon={Sparkles} title="No automations here" body="Try a different filter, or describe your first automation." action={() => selectTab("create")} />}
        </section>
      ) : null}

      {tab === "runs" ? (
        <section className="automation-panel runs-panel-new" role="tabpanel" aria-labelledby="automation-tab-runs">
          <div className="automation-toolbar">
            <SearchBox value={query} onChange={setQuery} placeholder="Search runs" />
            <FilterPills value={runFilter} onChange={(value) => setRunFilter(value as RunFilter)} items={["all", "succeeded", "failed", "waiting"]} />
          </div>
          {filteredRuns.length ? <RunTimeline runs={filteredRuns} onOpen={(run) => router.push(`/app/workflows/${run.workflowId}`)} /> : <EmptyState icon={Activity} title="No runs here" body="Run an automation once or change the filter." />}
        </section>
      ) : null}

      {tab === "attention" ? (
        <section className="automation-panel attention-panel-new" role="tabpanel" aria-labelledby="automation-tab-attention">
          {attentionCount ? <><header><h1>{attentionCount === 1 ? "One thing is waiting on you" : `${attentionCount} things are waiting on you`}</h1><p>Clear the decisions and failures that keep your automations from moving.</p></header><div className="attention-stack">
            {approvals.map((approval) => <ApprovalCard approval={approval} busy={busy} onOpen={() => router.push(`/app/workflows/${approval.workflowId}`)} onDecide={decide} key={approval.id} />)}
            {failures.map((run) => <FailureCard run={run} onOpen={() => router.push(`/app/workflows/${run.workflowId}`)} key={run.id} />)}
          </div></> : <EmptyState icon={CheckCircle2} title="Nothing is waiting on you" body="Every automation is moving. Decisions and failures will appear here." />}
        </section>
      ) : null}
    </main>
  );
}

function AutomationTabs({ value, workflowCount, attentionCount, onChange }: { value: TabId; workflowCount: number; attentionCount: number; onChange: (tab: TabId) => void }) {
  return <div className="automation-tabs-wrap"><div className="automation-tabs" role="tablist" aria-label="Automations">{tabs.map((tab, index) => {
    const active = value === tab.id;
    const count = tab.id === "workflows" ? workflowCount : tab.id === "attention" ? attentionCount : 0;
    return <button id={`automation-tab-${tab.id}`} key={tab.id} role="tab" aria-selected={active} tabIndex={active ? 0 : -1} className={active ? "active" : ""} onClick={() => onChange(tab.id)} onKeyDown={(event) => {
      const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (!delta) return;
      event.preventDefault();
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      onChange(next.id);
      document.getElementById(`automation-tab-${next.id}`)?.focus();
    }}>{tab.label}{count ? <b className={tab.id === "attention" ? "urgent" : ""}>{count}</b> : null}</button>;
  })}</div></div>;
}

function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="automation-search"><Search size={16} /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} /></label>;
}

function FilterPills({ value, onChange, items }: { value: string; onChange: (value: string) => void; items: string[] }) {
  return <div className="automation-filters"><Filter size={14} />{items.map((item) => <button className={value === item ? "active" : ""} onClick={() => onChange(item)} key={item}>{item === "all" ? "All" : item[0].toUpperCase() + item.slice(1)}</button>)}</div>;
}

function AppStack({ apps }: { apps: string[] }) {
  return <span className="automation-app-stack">{apps.slice(0, 3).map((slug) => { const app = INTEGRATION_BY_SLUG.get(slug); return <ServiceIcon slug={slug} label={app?.name ?? slug} key={slug} />; })}</span>;
}

function WorkflowCard({ workflow, onOpen }: { workflow: AutomationListItem; onOpen: () => void }) {
  const stateLabel = workflow.state === "active" ? "Live" : workflow.state === "paused" ? "Paused" : "Draft";
  return <article className="workflow-card-new"><button className="workflow-card-hit" onClick={onOpen} aria-label={`Open ${workflow.name}`} /><div className="workflow-card-top"><AppStack apps={workflow.apps} /><span className={`workflow-state ${workflow.state}`}><i />{stateLabel}</span></div><h2>{workflow.name}</h2><p>{workflow.description}</p><footer><span><Clock3 size={13} />{workflow.lastRunAt ? `Last ran ${relativeTime(workflow.lastRunAt)}` : `Edited ${relativeTime(workflow.updatedAt)}`}</span><ArrowRight size={15} /></footer></article>;
}

function RunTimeline({ runs, onOpen }: { runs: AutomationRunItem[]; onOpen: (run: AutomationRunItem) => void }) {
  return <div className="run-timeline-new">{runs.map((run) => { const Icon = run.status === "succeeded" ? Check : run.status === "failed" ? TriangleAlert : run.status === "waiting" ? Clock3 : Play; return <button onClick={() => onOpen(run)} key={run.id}><span className={`run-dot-new ${run.status}`}><Icon size={14} /></span><div><b>{run.workflowName}</b><small>{run.trigger} · {relativeTime(run.startedAt)}</small></div><em className={run.status}>{run.status}</em><span>{run.duration}</span><span>{run.credits} credits</span><ArrowRight size={14} /></button>; })}</div>;
}

function ApprovalCard({ approval, busy, onOpen, onDecide }: { approval: AutomationApprovalItem; busy: string | null; onOpen: () => void; onDecide: (id: string, decision: "approved" | "rejected") => void }) {
  return <article className="attention-card-new lead"><header><span><Inbox size={16} /></span><div><small>Approval needed · {relativeTime(approval.requestedAt)}</small><h2>{approval.workflowName}</h2></div><button onClick={onOpen}>Open workflow <ArrowRight size={13} /></button></header><div className="attention-preview"><small>Automata is waiting before it continues</small><b>{approval.prompt}</b><p>{previewText(approval.preview)}</p></div><footer><button disabled={busy !== null} onClick={() => onDecide(approval.id, "rejected")}><X size={14} />Reject</button><button className="approve" disabled={busy !== null} onClick={() => onDecide(approval.id, "approved")}>{busy === `${approval.id}-approved` ? <Loader2 className="spin" size={14} /> : <Check size={14} />}Approve and continue</button></footer></article>;
}

function FailureCard({ run, onOpen }: { run: AutomationRunItem; onOpen: () => void }) {
  return <article className="attention-card-new failure"><header><span><TriangleAlert size={16} /></span><div><small>Run failed · {relativeTime(run.startedAt)}</small><h2>{run.workflowName}</h2></div><button onClick={onOpen}>Inspect run <ArrowRight size={13} /></button></header><div className="attention-preview"><small>Stopped before completion</small><b>{run.error ?? "A module could not complete its action."}</b><p>No later steps were executed. Open the workflow to inspect the configuration and run it again.</p></div></article>;
}

function EmptyState({ icon: Icon, title, body, action }: { icon: typeof Sparkles; title: string; body: string; action?: () => void }) {
  return <div className="automation-empty"><Icon size={25} /><b>{title}</b><p>{body}</p>{action ? <button onClick={action}>Create an automation</button> : null}</div>;
}

function relativeTime(input: string) {
  const delta = Date.now() - new Date(input).getTime();
  const minutes = Math.max(1, Math.floor(delta / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function previewText(preview: unknown) {
  if (typeof preview === "string") return preview;
  if (preview && typeof preview === "object") {
    const record = preview as Record<string, unknown>;
    const readable = record.message ?? record.body ?? record.text ?? record.content;
    if (typeof readable === "string") return readable;
  }
  return "Review the exact action and payload before the run resumes.";
}
