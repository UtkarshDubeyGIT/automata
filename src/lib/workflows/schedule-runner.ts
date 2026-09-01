import "server-only";

import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { executeStoredRun } from "./run-service";
import { nextCronOccurrence } from "./schedule";
import type { WorkflowGraph } from "./types";

export async function sweepDueSchedules(admin: SupabaseClient, limit = 10) {
  const now = new Date();
  const { data: workflows, error } = await admin.from("workflows").select("id,workspace_id,published_version_id,next_run_at").eq("state", "active").not("next_run_at", "is", null).lte("next_run_at", now.toISOString()).order("next_run_at").limit(limit);
  if (error) throw new Error(`Schedule sweep failed: ${error.message}`);
  const results = [];

  for (const workflow of workflows ?? []) {
    const { data: version } = await admin.from("workflow_versions").select("graph").eq("id", workflow.published_version_id).single();
    const graph = version?.graph as WorkflowGraph | undefined;
    const trigger = graph ? Object.values(graph.steps).find((step) => step.type === "schedule_trigger") : undefined;
    if (!graph || !trigger?.cron) {
      await admin.from("workflows").update({ state: "paused", next_run_at: null }).eq("id", workflow.id);
      results.push({ workflowId: workflow.id, state: "invalid_schedule" });
      continue;
    }
    const { data: workspace } = await admin.from("workspaces").select("timezone").eq("id", workflow.workspace_id).single();
    let nextRun: string;
    try {
      nextRun = nextCronOccurrence(String(trigger.cron), String(trigger.timezone ?? workspace?.timezone ?? "UTC"), new Date(workflow.next_run_at)).toISOString();
    } catch {
      await admin.from("workflows").update({ state: "paused", next_run_at: null }).eq("id", workflow.id);
      results.push({ workflowId: workflow.id, state: "invalid_schedule" });
      continue;
    }
    const { data: claimed } = await admin.from("workflows").update({ next_run_at: nextRun, last_run_at: now.toISOString() }).eq("id", workflow.id).eq("next_run_at", workflow.next_run_at).select("id").maybeSingle();
    if (!claimed) continue;
    const idempotencyKey = `schedule:${workflow.next_run_at}`;
    const { data: run, error: runError } = await admin.from("workflow_runs").insert({ workspace_id: workflow.workspace_id, workflow_id: workflow.id, workflow_version_id: workflow.published_version_id, idempotency_key: idempotencyKey, trigger_kind: "schedule", trigger_payload: { scheduled_at: workflow.next_run_at, observed_at: now.toISOString() } }).select("id").single();
    if (runError?.code === "23505") { results.push({ workflowId: workflow.id, state: "replayed" }); continue; }
    if (runError || !run) { results.push({ workflowId: workflow.id, state: "failed_to_queue" }); continue; }
    try {
      const result = await executeStoredRun(admin, { id: run.id, workspaceId: workflow.workspace_id, graph, triggerData: { scheduled_at: workflow.next_run_at, delivery_id: randomUUID() } });
      results.push({ workflowId: workflow.id, runId: run.id, state: result.state });
    } catch (runFailure) {
      await admin.from("workflow_runs").update({ status: "failed", error_code: "runner_error", error_message: runFailure instanceof Error ? runFailure.message : "Runner failed", finished_at: new Date().toISOString() }).eq("id", run.id);
      results.push({ workflowId: workflow.id, runId: run.id, state: "failed" });
    }
  }
  return results;
}
