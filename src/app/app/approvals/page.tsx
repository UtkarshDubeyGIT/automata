import { ApprovalInbox, type ApprovalItem } from "@/components/approvals/approval-inbox";
import { currentWorkspace } from "@/lib/workspace/current";

const approvals = [
  { workflow: "Daily pipeline digest", action: "Post to Slack", destination: "#sales-daily", body: "Pipeline moved by 12% this week. Three deals need an owner response today, led by Northstar Labs…", age: "8 minutes ago", credits: 1 },
  { workflow: "Urgent issue triage", action: "Post to Slack", destination: "#engineering-alerts", body: "Urgent: Checkout retries twice after a failed card. Customer impact is confirmed on mobile Safari.", age: "1 hour ago", credits: 1 },
];

export default async function ApprovalsPage() {
  const context = await currentWorkspace();
  const { data: stored } = context ? await context.supabase.from("approvals").select("id,prompt,preview,requested_at,workflow_runs(workflows(name))").eq("workspace_id", context.workspace.id).eq("status", "pending").order("requested_at", { ascending: false }) : { data: null };
  const items: ApprovalItem[] = stored ? stored.map((approval) => { const run = approval.workflow_runs as { workflows?: { name?: string } | Array<{ name?: string }> } | null; const workflow = Array.isArray(run?.workflows) ? run?.workflows[0]?.name : run?.workflows?.name; return { id: approval.id, workflow: workflow ?? "Workflow", prompt: approval.prompt, preview: approval.preview, requestedAt: approval.requested_at }; }) : approvals.map((approval, index) => ({ id: `preview-${index}`, workflow: approval.workflow, prompt: approval.action, preview: approval.body, requestedAt: new Date(Date.UTC(2026, 7, 31, 8 - index)).toISOString() }));
  return <main className="app-page approvals-page"><header className="page-title-row"><div><span className="page-kicker">Human in the loop</span><h1>Approvals</h1><p>Inspect the exact action before Automata continues.</p></div></header><div className="approval-layout"><ApprovalInbox initial={items} /><aside className="approval-policy"><h2>Approval policy</h2><p>AI-created workflows pause before external writes unless the author explicitly requests unattended execution.</p><dl><div><dt>Customer messages</dt><dd>Always ask</dd></div><div><dt>Public publishing</dt><dd>Always ask</dd></div><div><dt>Internal data sync</dt><dd>Workflow setting</dd></div></dl></aside></div></main>;
}
