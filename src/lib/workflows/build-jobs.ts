import { randomUUID } from "node:crypto";
import { CREDIT_COST, grantCredits } from "@/lib/credits";
import { createAdminClient } from "@/lib/supabase/server";
import { claimJob } from "@/lib/jobs/lock";
import type { BuildEvent, BuildOutput } from "./builder";
import { buildWorkflow } from "./builder";
import type { BuildJobStatus, BuildJobView } from "./build-request";
import { recordWorkflowBuildEvent } from "./diagnostics";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BuildJobDb = { from(table: string): any; rpc(name: string, args: Record<string, unknown>): any };

export interface WorkflowBuildJob {
  id: string;
  workspace_id: string;
  request_key: string;
  correlation_id?: string | null;
  prompt: string;
  status: BuildJobStatus;
  result: BuildOutput | null;
  error: string | null;
  error_code: string | null;
  attempts: number;
  claimed_at: string | null;
  claimed_by: string | null;
  charged_at: string | null;
  refunded_at: string | null;
  available_at: string;
  expires_at: string;
  updated_at: string;
}

export type EnqueueWorkflowBuildResult =
  | { job: WorkflowBuildJob; duplicate: boolean; balance: number; cost: number; outcome: "queued" }
  | { job: null; duplicate: false; balance: number; cost: number; outcome: "insufficient" };

export function workflowBuildView(job: WorkflowBuildJob): BuildJobView {
  return {
    id: job.id,
    status: job.status,
    updatedAt: job.updated_at,
    ...(job.correlation_id ? { correlationId: job.correlation_id } : {}),
    ...(job.error_code ? { errorCode: job.error_code } : {}),
    ...(job.status === "completed" && job.result ? { build: job.result } : {}),
    ...(job.status === "failed" && job.error ? { error: job.error } : {}),
  };
}

export async function enqueueWorkflowBuild(
  db: BuildJobDb,
  input: { workspaceId: string; requestKey: string; prompt: string },
): Promise<EnqueueWorkflowBuildResult> {
  const { data, error } = await db.rpc("enqueue_workflow_build", {
    p_workspace_id: input.workspaceId,
    p_request_key: input.requestKey,
    p_prompt: input.prompt,
    p_cost: CREDIT_COST.workflow_build,
  });
  if (error || !data) throw new Error(`Could not queue workflow build: ${error?.message ?? "empty response"}`);
  return data as EnqueueWorkflowBuildResult;
}

export async function getWorkflowBuild(
  db: BuildJobDb,
  id: string,
  workspaceId?: string,
): Promise<WorkflowBuildJob | null> {
  let query = db.from("workflow_builds").select("*").eq("id", id);
  if (workspaceId) query = query.eq("workspace_id", workspaceId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Could not load workflow build: ${error.message}`);
  return (data as WorkflowBuildJob | null) ?? null;
}

/**
 * Persist an AI edit to its existing preview job. Create-mode follow-ups keep
 * the same job id, so the ordinary save endpoint still loads and validates the
 * latest graph from the server rather than trusting a client-supplied graph.
 */
export async function updateWorkflowBuildResult(
  db: BuildJobDb,
  id: string,
  workspaceId: string,
  result: BuildOutput,
): Promise<string | null> {
  const updatedAt = new Date().toISOString();
  const { data, error } = await db
    .from("workflow_builds")
    .update({ result, updated_at: updatedAt })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .eq("status", "completed")
    .select("updated_at")
    .maybeSingle();
  if (error) throw new Error(`Could not save workflow draft edit: ${error.message}`);
  return data?.updated_at ?? null;
}

/** Serialize draft edits with one another and with workflow creation. */
export function claimWorkflowDraft(db: BuildJobDb, id: string) {
  return claimJob(db, `workflow-draft:${id.toLowerCase()}`, 150_000, randomUUID());
}

export async function claimWorkflowBuild(
  db: BuildJobDb,
  id: string,
  holder: string,
  now = new Date(),
): Promise<WorkflowBuildJob | null> {
  const existing = await getWorkflowBuild(db, id);
  if (!existing || existing.status !== "queued") return null;
  const { data, error } = await db
    .from("workflow_builds")
    .update({
      status: "running",
      claimed_at: now.toISOString(),
      claimed_by: holder,
      attempts: existing.attempts + 1,
      updated_at: now.toISOString(),
    })
    .eq("id", id)
    .eq("status", "queued")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not claim workflow build: ${error.message}`);
  return (data as WorkflowBuildJob | null) ?? null;
}

export async function runWorkflowBuild(
  db: BuildJobDb,
  id: string,
  deps?: {
    build?: (prompt: string, options?: { deadline?: number; onEvent?: (event: BuildEvent) => Promise<void> | void }) => Promise<BuildOutput>;
    refund?: (workspaceId: string, jobId: string) => Promise<void>;
    now?: () => Date;
    holder?: string;
  },
): Promise<WorkflowBuildJob | null> {
  const now = deps?.now ?? (() => new Date());
  const refund = deps?.refund ?? refundWorkflowBuild;
  const existing = await getWorkflowBuild(db, id);
  if (!existing) return null;

  // The build already failed but its compensating ledger write did not land.
  // Recovery finishes the refund and never calls the model again.
  if (existing.status === "failed") {
    if (!existing.charged_at || existing.refunded_at) return existing;
    await recordWorkflowBuildEvent(db, {
      workspaceId: existing.workspace_id,
      buildJobId: existing.id,
      correlationId: existing.correlation_id,
      eventType: "build_recovery_started",
      stage: "recovery",
      eventKey: `${existing.id}:recovery:start`,
    });
    try {
      await refund(existing.workspace_id, existing.id);
      const refundedAt = now().toISOString();
      const { data } = await db
        .from("workflow_builds")
        .update({ refunded_at: refundedAt, updated_at: refundedAt })
        .eq("id", existing.id)
        .eq("status", "failed")
        .is("refunded_at", null)
        .select("*")
        .maybeSingle();
      await recordWorkflowBuildEvent(db, {
        workspaceId: existing.workspace_id,
        buildJobId: existing.id,
        correlationId: existing.correlation_id,
        eventType: "build_recovery_completed",
        stage: "recovery",
        eventKey: `${existing.id}:recovery:completed`,
      });
      return (data as WorkflowBuildJob | null) ?? getWorkflowBuild(db, id);
    } catch (err) {
      console.error("[workflows/build] refund recovery failed:", err);
      await recordWorkflowBuildEvent(db, {
        workspaceId: existing.workspace_id,
        buildJobId: existing.id,
        correlationId: existing.correlation_id,
        eventType: "build_recovery_failed",
        stage: "recovery",
        level: "error",
        errorCode: "refund_recovery_failed",
        eventKey: `${existing.id}:recovery:failed`,
      });
      return existing;
    }
  }

  if (existing.status === "queued" && existing.attempts >= MAX_BUILD_ATTEMPTS) {
    const failedAt = now().toISOString();
    const { data: failed } = await db
      .from("workflow_builds")
      .update({
        status: "failed",
        error: "The builder could not finish after several attempts — please try again.",
        error_code: "attempts_exhausted",
        finished_at: failedAt,
        updated_at: failedAt,
      })
      .eq("id", existing.id)
      .eq("status", "queued")
      .select("*")
      .maybeSingle();
    if (failed) {
      await recordWorkflowBuildEvent(db, {
        workspaceId: existing.workspace_id,
        buildJobId: existing.id,
        correlationId: existing.correlation_id,
        eventType: "build_attempts_exhausted",
        stage: "recovery",
        level: "error",
        attempt: existing.attempts,
        errorCode: "attempts_exhausted",
        eventKey: `${existing.id}:attempts-exhausted`,
      });
      return runWorkflowBuild(db, id, deps);
    }
    return getWorkflowBuild(db, id);
  }

  const holder = deps?.holder ?? randomUUID();
  const job = await claimWorkflowBuild(db, id, holder, now());
  if (!job) return getWorkflowBuild(db, id);
  await recordWorkflowBuildEvent(db, {
    workspaceId: job.workspace_id,
    buildJobId: job.id,
    correlationId: job.correlation_id,
    eventType: "build_claimed",
    stage: "claim",
    attempt: job.attempts,
    eventKey: `${job.id}:attempt:${job.attempts}:claim`,
    metadata: { requestKey: job.request_key },
  });
  const build = deps?.build ?? buildWorkflow;
  const startedAt = Date.now();
  await recordWorkflowBuildEvent(db, {
    workspaceId: job.workspace_id,
    buildJobId: job.id,
    correlationId: job.correlation_id,
    eventType: "build_started",
    stage: "model",
    attempt: job.attempts,
    eventKey: `${job.id}:attempt:${job.attempts}:model`,
  });

  try {
    const result = await build(job.prompt, {
      deadline: Date.now() + BUILD_BUDGET_MS,
      onEvent: async (event) => {
        await recordWorkflowBuildEvent(db, {
          workspaceId: job.workspace_id,
          buildJobId: job.id,
          correlationId: job.correlation_id,
          eventType: event.eventType,
          stage: event.stage,
          level: event.level,
          attempt: event.attempt ?? job.attempts,
          errorCode: event.errorCode,
          eventKey: `${job.id}:attempt:${job.attempts}:${event.eventType}:${event.attempt ?? 0}`,
          metadata: event.metadata,
        });
      },
    });
    const finishedAt = now().toISOString();
    const { data } = await db
      .from("workflow_builds")
      .update({
        status: "completed",
        result,
        error: null,
        error_code: null,
        finished_at: finishedAt,
        updated_at: finishedAt,
        claimed_at: null,
        claimed_by: null,
      })
      .eq("id", job.id)
      .eq("status", "running")
      .eq("claimed_by", holder)
      .select("*")
      .maybeSingle();
    await recordWorkflowBuildEvent(db, {
      workspaceId: job.workspace_id,
      buildJobId: job.id,
      correlationId: job.correlation_id,
      eventType: "build_completed",
      stage: "validation",
      attempt: job.attempts,
      durationMs: Date.now() - startedAt,
      eventKey: `${job.id}:build_completed`,
    });
    return (data as WorkflowBuildJob | null) ?? getWorkflowBuild(db, id);
  } catch (err) {
    const finishedAt = now().toISOString();
    const safe = safeBuildError(err);
    const { data: failed } = await db
      .from("workflow_builds")
      .update({
        status: "failed",
        error: safe.message,
        error_code: safe.code,
        finished_at: finishedAt,
        updated_at: finishedAt,
        claimed_at: null,
        claimed_by: null,
      })
      .eq("id", job.id)
      .eq("status", "running")
      .eq("claimed_by", holder)
      .select("*")
      .maybeSingle();
    if (!failed) return getWorkflowBuild(db, id);
    await recordWorkflowBuildEvent(db, {
      workspaceId: job.workspace_id,
      buildJobId: job.id,
      correlationId: job.correlation_id,
      eventType: "build_failed",
      stage: "model",
      level: "error",
      attempt: job.attempts,
      durationMs: Date.now() - startedAt,
      errorCode: safe.code,
      eventKey: `${job.id}:attempt:${job.attempts}:failed`,
    });
    try {
      await refund(job.workspace_id, job.id);
      const refundedAt = now().toISOString();
      const { data } = await db
        .from("workflow_builds")
        .update({ refunded_at: refundedAt, updated_at: refundedAt })
        .eq("id", job.id)
        .eq("status", "failed")
        .is("refunded_at", null)
        .select("*")
        .maybeSingle();
      await recordWorkflowBuildEvent(db, {
        workspaceId: job.workspace_id,
        buildJobId: job.id,
        correlationId: job.correlation_id,
        eventType: "build_refunded",
        stage: "refund",
        attempt: job.attempts,
        eventKey: `${job.id}:refunded`,
      });
      return (data as WorkflowBuildJob | null) ?? getWorkflowBuild(db, id);
    } catch (refundErr) {
      console.error("[workflows/build] refund failed:", refundErr);
      return failed as WorkflowBuildJob;
    }
  }
}

export async function drainWorkflowBuilds(
  db: BuildJobDb,
  options?: { limit?: number; deadline?: number },
): Promise<{ examined: number; completed: number; failed: number; deferred: number }> {
  const limit = options?.limit ?? 2;
  const deadline = options?.deadline ?? Date.now() + BUILD_BUDGET_MS;
  const staleBefore = new Date(Date.now() - BUILD_LEASE_MS).toISOString();
  await db
    .from("workflow_builds")
    .update({ status: "queued", claimed_at: null, claimed_by: null })
    .eq("status", "running")
    .lt("claimed_at", staleBefore);

  // A worker may have persisted failure and died before the compensating
  // ledger write. Settle those rows without ever invoking the model again.
  const { data: refundRows } = await db
    .from("workflow_builds")
    .select("*")
    .eq("status", "failed")
    .is("refunded_at", null)
    .order("created_at", { ascending: true })
    .limit(limit);
  for (const job of (refundRows as WorkflowBuildJob[] | null) ?? []) {
    if (Date.now() >= deadline) break;
    await runWorkflowBuild(db, job.id);
  }

  await deleteExpiredWorkflowBuilds(db);

  const { data } = await db
    .from("workflow_builds")
    .select("*")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(Math.max(limit * 3, limit));
  const jobs = ((data as WorkflowBuildJob[] | null) ?? []).filter(
    (job) => new Date(job.available_at).getTime() <= Date.now(),
  );
  let examined = 0;
  let completed = 0;
  let failed = 0;
  for (const job of jobs) {
    if (examined >= limit || Date.now() >= deadline) break;
    const before = job.status;
    const result = await runWorkflowBuild(db, job.id);
    if (result?.status === before || result?.status === "running") continue;
    examined++;
    if (result?.status === "completed") completed++;
    if (result?.status === "failed") failed++;
  }
  return { examined, completed, failed, deferred: Math.max(0, jobs.length - examined) };
}

export async function deleteExpiredWorkflowBuilds(
  db: BuildJobDb,
  now = new Date(),
): Promise<void> {
  const expiredBefore = now.toISOString();
  await db
    .from("workflow_builds")
    .delete()
    .eq("status", "completed")
    .lt("expires_at", expiredBefore);
  // Keep the recovery record for as long as the user's compensating credit is
  // missing. It is eligible for cleanup immediately after refund succeeds.
  await db
    .from("workflow_builds")
    .delete()
    .eq("status", "failed")
    .not("refunded_at", "is", null)
    .lt("expires_at", expiredBefore);
}

const BUILD_BUDGET_MS = 75_000;
const BUILD_LEASE_MS = 2 * 60_000;
const MAX_BUILD_ATTEMPTS = 3;

async function refundWorkflowBuild(workspaceId: string, jobId: string): Promise<void> {
  await grantCredits(
    workspaceId,
    CREDIT_COST.workflow_build,
    "refund",
    `workflow_build:${jobId}`,
    `workflow-build-refund:${jobId}`,
  );
}

function safeBuildError(err: unknown): { code: string; message: string } {
  const message = err instanceof Error ? err.message : "";
  const name = err instanceof Error ? err.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { code: "timeout", message: "The builder took too long this time — please try again." };
  }
  // BuildError/provider messages are already written for the user. Unknown
  // exceptions stay in server logs rather than leaking internals into chat.
  if (message && !/stack|sql|database|supabase/i.test(message)) {
    return { code: "build_failed", message };
  }
  console.error("[workflows/build] unexpected worker failure:", err);
  return { code: "unexpected", message: "The builder hit an unexpected error — try again." };
}

export async function kickWorkflowBuilds(
  suppliedDb?: BuildJobDb,
): Promise<{ examined: number; completed: number; failed: number; deferred: number }> {
  const db = suppliedDb ?? (createAdminClient() as unknown as BuildJobDb);
  const results = await Promise.all([0, 1].map(async (slot) => {
    const lock = await claimJob(db, `workflow-build:${slot}`, BUILD_LEASE_MS, randomUUID());
    if (!lock.ok) return { examined: 0, completed: 0, failed: 0, deferred: 0 };
    try {
      return await drainWorkflowBuilds(db, { limit: 1 });
    } finally {
      await lock.release().catch(() => {});
    }
  }));
  return results.reduce(
    (total, result) => ({
      examined: total.examined + result.examined,
      completed: total.completed + result.completed,
      failed: total.failed + result.failed,
      deferred: total.deferred + result.deferred,
    }),
    { examined: 0, completed: 0, failed: 0, deferred: 0 },
  );
}
