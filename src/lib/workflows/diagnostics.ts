import "server-only";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DiagnosticDb = { from(table: string): any };

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticStage =
  | "enqueue"
  | "claim"
  | "model"
  | "tool_selection"
  | "validation"
  | "repair"
  | "refund"
  | "preview"
  | "save"
  | "recovery";

export interface WorkflowBuildDiagnosticInput {
  workspaceId: string;
  eventType: string;
  stage: DiagnosticStage;
  level?: DiagnosticLevel;
  correlationId?: string | null;
  buildJobId?: string | null;
  actorId?: string | null;
  attempt?: number | null;
  durationMs?: number | null;
  errorCode?: string | null;
  eventKey?: string | null;
  metadata?: Record<string, unknown>;
}

export interface WorkflowBuildDiagnosticRow {
  workspace_id: string;
  event_key: string;
  event_type: string;
  level: DiagnosticLevel;
  stage: DiagnosticStage;
  correlation_id: string | null;
  build_job_id: string | null;
  actor_id: string | null;
  attempt: number | null;
  duration_ms: number | null;
  error_code: string | null;
  metadata: Record<string, string | number | boolean>;
}

const SAFE_METADATA_KEYS = new Set([
  "workflowId",
  "creationKey",
  "requestKey",
  "provider",
  "status",
  "source",
  "destination",
  "deliveryId",
]);

function short(value: unknown, max = 160): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).replace(/[\r\n\t]+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function safeIdentifier(value: unknown): string | null {
  const text = short(value, 120);
  return text && /^[A-Za-z0-9_:.\-]+$/.test(text) ? text : null;
}

export function sanitizeDiagnosticEvent(input: WorkflowBuildDiagnosticInput): WorkflowBuildDiagnosticRow {
  const metadata: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    if (typeof value === "string") {
      const safe = short(value);
      if (safe) metadata[key] = safe;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      metadata[key] = value;
    } else if (typeof value === "boolean") {
      metadata[key] = value;
    }
  }
  const eventType = safeIdentifier(input.eventType) ?? "unknown";
  const correlationId = safeIdentifier(input.correlationId);
  const buildJobId = safeIdentifier(input.buildJobId);
  const actorId = safeIdentifier(input.actorId);
  const errorCode = safeIdentifier(input.errorCode);
  const eventKey =
    safeIdentifier(input.eventKey) ??
    [buildJobId ?? "no-job", correlationId ?? "no-correlation", eventType].join(":");
  const attempt = Number.isInteger(input.attempt) && Number(input.attempt) >= 0 ? Number(input.attempt) : null;
  const durationMs = Number.isFinite(input.durationMs) && Number(input.durationMs) >= 0 ? Math.round(Number(input.durationMs)) : null;
  return {
    workspace_id: safeIdentifier(input.workspaceId) ?? "unknown-workspace",
    event_key: eventKey,
    event_type: eventType,
    level: input.level ?? (eventType.includes("failed") ? "error" : "info"),
    stage: input.stage,
    correlation_id: correlationId,
    build_job_id: buildJobId,
    actor_id: actorId,
    attempt,
    duration_ms: durationMs,
    error_code: errorCode,
    metadata,
  };
}

/** Best-effort by design: a logger outage must never fail a valid build/save. */
export async function recordWorkflowBuildEvent(
  db: DiagnosticDb | null | undefined,
  input: WorkflowBuildDiagnosticInput,
): Promise<void> {
  if (!db) return;
  try {
    const row = sanitizeDiagnosticEvent(input);
    const { error } = await db.from("workflow_build_events").insert(row);
    if (error && error.code !== "23505") {
      // Do not log the row: metadata has already been narrowed, but keeping
      // provider/DB messages out of the diagnostics path avoids recursion.
      return;
    }
  } catch {
    // Observability is intentionally non-authoritative.
  }
}

export async function listWorkflowBuildEvents(
  db: DiagnosticDb,
  workspaceId: string,
  options?: { buildJobId?: string; limit?: number },
): Promise<WorkflowBuildDiagnosticRow[]> {
  const limit = Math.min(Math.max(options?.limit ?? 100, 1), 500);
  let query = db
    .from("workflow_build_events")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (options?.buildJobId) query = query.eq("build_job_id", options.buildJobId);
  const { data, error } = await query;
  if (error) throw new Error(`Could not load workflow diagnostics: ${error.message}`);
  return (data as WorkflowBuildDiagnosticRow[] | null) ?? [];
}

export async function purgeWorkflowBuildEvents(
  db: DiagnosticDb,
  now = new Date(),
  retentionDays = 30,
): Promise<void> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  await db.from("workflow_build_events").delete().lt("created_at", cutoff);
}
