import "server-only";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DeliveryDb = { from(table: string): any };

export type ReportDeliveryStatus = "pending" | "sending" | "sent" | "definitive_failure" | "unknown";

export interface ReportDelivery {
  id: string;
  workspace_id: string;
  workflow_run_id: string;
  step_id: string;
  destination_account_id: string;
  recipient: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: ReportDeliveryStatus;
  provider_receipt_id?: string | null;
  error_code?: string | null;
  attempt: number;
  created_at?: string;
  updated_at?: string;
}

export interface ClaimReportDeliveryInput {
  workspaceId: string;
  runId: string;
  stepId: string;
  destinationAccountId: string;
  recipient: string;
  payload: Record<string, unknown>;
  window?: { startDate: string; endDate: string; timeZone: string };
}

const RECEIPT_KEYS = ["id", "messageId", "threadId", "externalId", "url", "simulated", "ok", "successful"] as const;

/** Store only a bounded receipt, never the outgoing body or provider payload. */
export function compactProviderResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of RECEIPT_KEYS) {
    const candidate = source[key];
    if (typeof candidate === "string" || typeof candidate === "boolean" || typeof candidate === "number") {
      compact[key] = typeof candidate === "string" ? candidate.slice(0, 240) : candidate;
    }
  }
  const nested = source.data;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const data: Record<string, unknown> = {};
    for (const key of RECEIPT_KEYS) {
      const candidate = (nested as Record<string, unknown>)[key];
      if (typeof candidate === "string" || typeof candidate === "boolean" || typeof candidate === "number") {
        data[key] = typeof candidate === "string" ? candidate.slice(0, 240) : candidate;
      }
    }
    if (Object.keys(data).length) compact.data = data;
  }
  return compact;
}

export function deliveryIdentity(input: Omit<ClaimReportDeliveryInput, "payload" | "window">): string {
  return [
    input.workspaceId.trim(),
    input.runId.trim(),
    input.stepId.trim(),
    input.destinationAccountId.trim(),
    input.recipient.trim(),
  ].join(":");
}

export async function claimReportDelivery(
  db: DeliveryDb,
  input: ClaimReportDeliveryInput,
): Promise<{ delivery: ReportDelivery; created: boolean }> {
  const idempotencyKey = deliveryIdentity(input);
  const row = {
    workspace_id: input.workspaceId,
    workflow_run_id: input.runId,
    step_id: input.stepId,
    destination_account_id: input.destinationAccountId,
    recipient: input.recipient.trim(),
    idempotency_key: idempotencyKey,
    payload: { ...input.payload, ...(input.window ? { window: input.window } : {}) },
    status: "pending" as const,
    attempt: 1,
  };
  const inserted = await db.from("workflow_report_deliveries").insert(row).select("*").maybeSingle();
  if (!inserted.error && inserted.data) return { delivery: inserted.data as ReportDelivery, created: true };
  if (inserted.error?.code !== "23505") {
    throw new Error(`Could not claim report delivery: ${inserted.error?.message ?? "empty response"}`);
  }
  const existing = await db
    .from("workflow_report_deliveries")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (existing.error || !existing.data) throw new Error("Could not recover the existing report delivery");
  return { delivery: existing.data as ReportDelivery, created: false };
}

export async function transitionReportDelivery(
  db: DeliveryDb,
  id: string,
  status: ReportDeliveryStatus,
  details?: { providerReceiptId?: string; errorCode?: string; providerResult?: Record<string, unknown> },
): Promise<ReportDelivery | null> {
  const patch: Record<string, unknown> = { status, updated_at: new Date().toISOString() };
  if (details?.providerReceiptId) patch.provider_receipt_id = details.providerReceiptId;
  if (details?.errorCode) patch.error_code = details.errorCode;
  if (details?.providerResult) {
    const current = (await db.from("workflow_report_deliveries").select("payload").eq("id", id).maybeSingle()).data as { payload?: Record<string, unknown> } | null;
    patch.payload = { ...(current?.payload ?? {}), providerResult: details.providerResult };
  }
  const result = await db.from("workflow_report_deliveries").update(patch).eq("id", id).select("*").maybeSingle();
  if (result.error) throw new Error(`Could not update report delivery: ${result.error.message}`);
  return (result.data as ReportDelivery | null) ?? null;
}

/** Park abandoned claims after a worker crash; never silently send again. */
export async function expireReportDeliveries(
  db: DeliveryDb,
  now = new Date(),
  timeoutMinutes = 15,
): Promise<void> {
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000).toISOString();
  await db
    .from("workflow_report_deliveries")
    .update({ status: "unknown", error_code: "delivery_claim_expired", updated_at: now.toISOString() })
    .in("status", ["pending", "sending"])
    .lt("updated_at", cutoff);
}
