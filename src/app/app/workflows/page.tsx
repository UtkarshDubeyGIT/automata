import { AutomationHub, type AutomationApprovalItem, type AutomationListItem, type AutomationRunItem } from "@/components/workflow/automation-hub";
import { TEMPLATES } from "@/lib/workflows/templates";
import { currentWorkspace } from "@/lib/workspace/current";

const demoWorkflows: AutomationListItem[] = [
  { id: "daily-pipeline-digest", name: "Daily pipeline digest", description: "Summarize open HubSpot deals and post the decisions that matter to Slack.", state: "active", apps: ["hubspot", "slack"], updatedAt: "2026-08-31T08:58:00Z", lastRunAt: "2026-08-31T09:00:02Z" },
  { id: "shopify-order-alerts", name: "Shopify order alerts", description: "Turn every new order into a concise WhatsApp operations alert.", state: "active", apps: ["shopify", "whatsapp"], updatedAt: "2026-08-31T07:25:00Z", lastRunAt: "2026-08-31T08:47:21Z" },
  { id: "urgent-issue-triage", name: "Urgent issue triage", description: "Classify GitHub issues and escalate the urgent ones to engineering.", state: "active", apps: ["github", "slack"], updatedAt: "2026-08-30T18:05:00Z", lastRunAt: "2026-08-31T08:15:43Z" },
  { id: "lead-capture", name: "Lead capture", description: "Normalize inbound lead data before creating a HubSpot contact.", state: "draft", apps: ["hubspot", "slack"], updatedAt: "2026-08-30T15:42:00Z", lastRunAt: null },
  { id: "linkedin-publisher", name: "LinkedIn publisher", description: "Polish content-sheet drafts and keep final publishing human-approved.", state: "paused", apps: ["googlesheets", "linkedin"], updatedAt: "2026-08-29T10:18:00Z", lastRunAt: "2026-08-29T10:20:00Z" },
];

export default async function WorkflowsPage() {
  const context = await currentWorkspace();
  if (!context) return <AutomationHub workflows={demoWorkflows} runs={demoRuns} approvals={demoApprovals} templates={TEMPLATES} />;

  const [workflowResult, runResult, approvalResult] = await Promise.all([
    context.supabase.from("workflows").select("id,name,description,state,updated_at,last_run_at").eq("workspace_id", context.workspace.id).order("updated_at", { ascending: false }),
    context.supabase.from("workflow_runs").select("id,workflow_id,status,trigger_kind,started_at,created_at,finished_at,credits_used,error_message,workflows(name)").eq("workspace_id", context.workspace.id).order("created_at", { ascending: false }).limit(100),
    context.supabase.from("approvals").select("id,run_id,prompt,preview,requested_at,workflow_runs(workflow_id,workflows(name))").eq("workspace_id", context.workspace.id).eq("status", "pending").order("requested_at", { ascending: false }),
  ]);

  const workflows: AutomationListItem[] = (workflowResult.data ?? []).map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description || "No description yet.",
    state: workflow.state as AutomationListItem["state"],
    updatedAt: workflow.updated_at,
    lastRunAt: workflow.last_run_at,
    apps: inferApps(`${workflow.name} ${workflow.description}`),
  }));
  const runs: AutomationRunItem[] = (runResult.data ?? []).map((run) => {
    const relation = run.workflows as { name?: string } | Array<{ name?: string }> | null;
    const workflowName = Array.isArray(relation) ? relation[0]?.name : relation?.name;
    const started = new Date(run.started_at ?? run.created_at);
    const finished = run.finished_at ? new Date(run.finished_at) : null;
    return { id: run.id, workflowId: run.workflow_id, workflowName: workflowName ?? "Workflow", status: normalizeRunStatus(run.status), trigger: run.trigger_kind, startedAt: started.toISOString(), duration: finished ? `${Math.max(0, (finished.getTime() - started.getTime()) / 1000).toFixed(1)}s` : "—", credits: run.credits_used, error: run.error_message };
  });
  const approvals: AutomationApprovalItem[] = (approvalResult.data ?? []).map((approval) => {
    const run = approval.workflow_runs as { workflow_id?: string; workflows?: { name?: string } | Array<{ name?: string }> } | null;
    const workflowName = Array.isArray(run?.workflows) ? run.workflows[0]?.name : run?.workflows?.name;
    return { id: approval.id, workflowId: run?.workflow_id ?? "", workflowName: workflowName ?? "Workflow", prompt: approval.prompt, preview: approval.preview, requestedAt: approval.requested_at };
  });
  return <AutomationHub workflows={workflows} runs={runs} approvals={approvals} templates={TEMPLATES} />;
}

const demoRuns: AutomationRunItem[] = [
  { id: "preview-run-1", workflowId: "daily-pipeline-digest", workflowName: "Daily pipeline digest", status: "succeeded", trigger: "Schedule", startedAt: "2026-08-31T09:00:02Z", duration: "2.8s", credits: 4 },
  { id: "preview-run-2", workflowId: "shopify-order-alerts", workflowName: "Shopify order alerts", status: "succeeded", trigger: "Shopify", startedAt: "2026-08-31T08:47:21Z", duration: "1.4s", credits: 2 },
  { id: "preview-run-3", workflowId: "urgent-issue-triage", workflowName: "Urgent issue triage", status: "waiting", trigger: "GitHub", startedAt: "2026-08-31T08:15:43Z", duration: "4.1s", credits: 3 },
  { id: "preview-run-4", workflowId: "lead-capture", workflowName: "Lead capture", status: "failed", trigger: "Webhook", startedAt: "2026-08-31T07:54:10Z", duration: "0.9s", credits: 1, error: "HubSpot account needs to be reconnected." },
  { id: "preview-run-5", workflowId: "daily-pipeline-digest", workflowName: "Daily pipeline digest", status: "succeeded", trigger: "Manual", startedAt: "2026-08-30T16:22:11Z", duration: "2.5s", credits: 4 },
];

const demoApprovals: AutomationApprovalItem[] = [
  { id: "preview-approval-1", workflowId: "daily-pipeline-digest", workflowName: "Daily pipeline digest", prompt: "Post this pipeline digest to #sales-daily?", preview: "Pipeline moved by 12% this week. Three deals need an owner response today, led by Northstar Labs…", requestedAt: "2026-08-31T08:52:00Z" },
  { id: "preview-approval-2", workflowId: "urgent-issue-triage", workflowName: "Urgent issue triage", prompt: "Escalate this issue in #engineering-alerts?", preview: "Urgent: Checkout retries twice after a failed card. Customer impact is confirmed on mobile Safari.", requestedAt: "2026-08-31T08:01:00Z" },
];

function normalizeRunStatus(status: string): AutomationRunItem["status"] {
  if (status === "completed") return "succeeded";
  if (status === "waiting_approval") return "waiting";
  return (["succeeded", "waiting", "failed", "running", "queued"] as const).find((item) => item === status) ?? "queued";
}

function inferApps(text: string) {
  const value = text.toLowerCase();
  const candidates = ["gmail", "googlesheets", "googledrive", "googlecalendar", "slack", "notion", "airtable", "telegram", "whatsapp", "hubspot", "shopify", "github", "linkedin"];
  const found = candidates.filter((slug) => value.includes(slug) || value.includes(slug.replace("google", "google ")));
  return found.length ? found : ["slack"];
}
