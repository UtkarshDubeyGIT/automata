import { Check, ChevronRight, Clock3, Filter, Search, TriangleAlert } from "lucide-react";

import { currentWorkspace } from "@/lib/workspace/current";

const runRows = [
  ["Daily pipeline digest", "Succeeded", "Schedule", "Today, 09:00:02", "2.8s", "4"],
  ["Shopify order alerts", "Succeeded", "Shopify", "Today, 08:47:21", "1.4s", "2"],
  ["Urgent issue triage", "Waiting", "GitHub", "Today, 08:15:43", "4.1s", "3"],
  ["Lead capture", "Failed", "Webhook", "Today, 07:54:10", "0.9s", "1"],
  ["Daily pipeline digest", "Succeeded", "Manual", "Yesterday, 16:22:11", "2.5s", "4"],
  ["Shopify sales sheet", "Succeeded", "Shopify", "Yesterday, 15:08:04", "1.1s", "2"],
];

export default async function RunsPage() {
  const context = await currentWorkspace();
  const { data: stored } = context ? await context.supabase.from("workflow_runs").select("id,status,trigger_kind,started_at,finished_at,credits_used,workflows(name)").eq("workspace_id", context.workspace.id).order("created_at", { ascending: false }).limit(100) : { data: null };
  const rows = stored ? stored.map((run) => { const workflow = run.workflows as { name?: string } | Array<{ name?: string }> | null; const name = Array.isArray(workflow) ? workflow[0]?.name : workflow?.name; const started = run.started_at ? new Date(run.started_at) : null; const finished = run.finished_at ? new Date(run.finished_at) : null; const duration = started && finished ? `${((finished.getTime() - started.getTime()) / 1000).toFixed(1)}s` : "—"; return [name ?? "Deleted workflow", run.status[0].toUpperCase() + run.status.slice(1), run.trigger_kind, started?.toLocaleString() ?? "Queued", duration, String(run.credits_used), run.id]; }) : runRows.map((run, index) => [...run, `preview-${index}`]);
  return <main className="app-page list-page"><header className="page-title-row"><div><span className="page-kicker">Execution</span><h1>Run history</h1><p>Inputs, outputs, decisions, timing, and credits for every run.</p></div></header><div className="list-toolbar"><label><Search size={16} /><input placeholder="Search runs" /></label><button><Filter size={15} />All outcomes</button><button>Last 30 days</button><span>{rows.length} runs</span></div><section className="panel run-history"><div className="run-history-head"><span>Outcome</span><span>Automation</span><span>Trigger</span><span>Started</span><span>Duration</span><span>Credits</span><span /></div>{rows.map(([name, status, trigger, started, duration, credits, id], index) => <div className="run-history-row" key={String(id)}><i className={`run-state ${String(status).toLowerCase()}`}>{status === "Succeeded" ? <Check size={13} /> : status === "Waiting" ? <Clock3 size={13} /> : <TriangleAlert size={13} />}</i><div><b>{name}</b><small>Run {rows.length - index}</small></div><span>{trigger}</span><span>{started}</span><span>{duration}</span><span>{credits}</span><ChevronRight size={15} /></div>)}{rows.length === 0 ? <div className="empty-state"><Clock3 size={22} /><b>No runs yet</b><span>Run an automation once or publish its trigger.</span></div> : null}</section></main>;
}
