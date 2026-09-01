import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { redactForLog } from "@/lib/security/redact";
import { notifyWorkspace } from "@/lib/notifications/service";

import { executeWorkflow, type JournalEvent } from "./engine";
import { createProductionAdapter } from "./module-adapter";
import type { WorkflowGraph } from "./types";

type ResumeDecision = { approvalStepId: string; decision: "approved" | "rejected" };

interface StoredRun {
  id: string;
  workspaceId: string;
  graph: WorkflowGraph;
  triggerData: unknown;
  baseCredits?: number;
  existingOutputs?: Record<string, unknown>;
  resume?: ResumeDecision;
}

function requireData<T>(data: T | null, error: { message: string } | null, operation: string): T {
  if (error || data === null) throw new Error(`${operation}: ${error?.message ?? "no data returned"}`);
  return data;
}

export async function executeStoredRun(admin: SupabaseClient, run: StoredRun) {
  const { data: lastSteps } = await admin.from("workflow_run_steps").select("sequence").eq("run_id", run.id).order("sequence", { ascending: false }).limit(1);
  let sequence = Number(lastSteps?.[0]?.sequence ?? 0);
  const stepRows = new Map<string, string>();

  const journal = async (event: JournalEvent) => {
    if (event.state === "approved" || event.state === "rejected") return;
    const existingId = stepRows.get(event.stepId);
    const terminal = event.state === "succeeded" || event.state === "failed" || event.state === "waiting";

    if (existingId) {
      const { error } = await admin.from("workflow_run_steps").update({
        status: event.state === "started" ? "running" : event.state,
        output: redactForLog(event.output),
        error_code: event.error ? "module_failed" : null,
        error_message: event.error ?? null,
        credits_used: event.credits ?? 0,
        finished_at: terminal ? new Date().toISOString() : null,
      }).eq("id", existingId);
      if (error) throw new Error(`Journal update failed: ${error.message}`);
    } else {
      sequence += 1;
      const step = run.graph.steps[event.stepId];
      const { data, error } = await admin.from("workflow_run_steps").insert({
        workspace_id: run.workspaceId,
        run_id: run.id,
        step_id: event.stepId,
        step_type: step?.type ?? "unknown",
        sequence,
        status: event.state === "started" ? "running" : event.state,
        input: redactForLog(event.input),
        output: redactForLog(event.output),
        error_code: event.error ? "module_failed" : null,
        error_message: event.error ?? null,
        credits_used: event.credits ?? 0,
        started_at: new Date().toISOString(),
        finished_at: terminal ? new Date().toISOString() : null,
      }).select("id").single();
      const row = requireData(data as { id: string } | null, error, "Journal insert failed");
      stepRows.set(event.stepId, row.id);
    }

    if ((event.credits ?? 0) > 0) {
      const { error } = await admin.from("usage_ledger").insert({
        workspace_id: run.workspaceId,
        run_id: run.id,
        run_step_id: stepRows.get(event.stepId),
        idempotency_key: `${run.id}:${event.stepId}:${sequence}`,
        credits: event.credits,
        kind: "debit",
        description: `${run.graph.steps[event.stepId]?.name ?? event.stepId} executed`,
      });
      if (error && error.code !== "23505") throw new Error(`Usage write failed: ${error.message}`);
    }
  };

  const startedAt = new Date().toISOString();
  const { error: startError } = await admin.from("workflow_runs").update({ status: "running", started_at: startedAt, heartbeat_at: startedAt }).eq("id", run.id);
  if (startError) throw new Error(`Run could not start: ${startError.message}`);

  const result = await executeWorkflow({
    graph: run.graph,
    triggerData: run.triggerData,
    existingOutputs: run.existingOutputs,
    resume: run.resume,
    adapter: createProductionAdapter(run.workspaceId, journal),
  });
  const totalCredits = (run.baseCredits ?? 0) + result.creditsUsed;

  if (result.state === "waiting_approval" && result.waiting) {
    const { data, error } = await admin.from("approvals").insert({
      workspace_id: run.workspaceId,
      run_id: run.id,
      run_step_id: stepRows.get(result.waiting.stepId),
      prompt: result.waiting.prompt,
      preview: redactForLog({ outputs: result.outputs, nextStep: result.waiting.approveNext }),
    }).select("id").single();
    const approval = requireData(data as { id: string } | null, error, "Approval could not be created");
    const { error: updateError } = await admin.from("workflow_runs").update({
      status: "waiting",
      current_step_id: result.waiting.stepId,
      pending_approval_id: approval.id,
      context: { outputs: result.outputs },
      credits_used: totalCredits,
      heartbeat_at: new Date().toISOString(),
    }).eq("id", run.id);
    if (updateError) throw new Error(`Run could not pause: ${updateError.message}`);
    await notifyWorkspace(admin, { workspaceId: run.workspaceId, kind: "approval", title: "Workflow waiting for approval", body: result.waiting.prompt, href: "/app/approvals" });
    return { ...result, creditsUsed: totalCredits, runId: run.id, approvalId: approval.id };
  }

  const { error: finishError } = await admin.from("workflow_runs").update({
    status: result.state,
    current_step_id: null,
    pending_approval_id: null,
    context: { outputs: result.outputs },
    credits_used: totalCredits,
    error_code: result.state === "failed" ? "module_failed" : null,
    error_message: result.error ?? null,
    finished_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
  }).eq("id", run.id);
  if (finishError) throw new Error(`Run could not finish: ${finishError.message}`);
  if (result.state === "failed") await notifyWorkspace(admin, { workspaceId: run.workspaceId, kind: "failure", title: "Workflow run failed", body: result.error ?? "A module could not complete.", href: "/app/runs" });
  return { ...result, creditsUsed: totalCredits, runId: run.id };
}
