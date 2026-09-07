import twilio from "twilio";
import { env, twilioConfigured } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import {
  canReceiveWorkflowReminder,
  nextDeliveryStatus,
  normalizeTwilioStatus,
  retryDelayMs,
  sanitizeWhatsAppMessage,
  type DeliveryStatus,
  type WhatsAppEligibility,
} from "./core";

const MAX_ATTEMPTS = 5;

interface QueueReminderInput {
  workspaceId: string;
  workflowId?: string | null;
  runId?: string | null;
  stepId?: string | null;
  body: string;
  kind?: "workflow_summary" | "workflow_failure" | "workflow_approval" | "test";
  idempotencyKey?: string;
}

export interface QueueReminderResult {
  queued: boolean;
  deliveryId?: string;
  status: DeliveryStatus;
  reason?: string;
}

function client() {
  const username = env.twilioApiKey || env.twilioAccountSid;
  const password = env.twilioApiSecret || env.twilioAuthToken;
  return twilio(username, password, { accountSid: env.twilioAccountSid });
}

export async function queueWorkflowReminder(input: QueueReminderInput): Promise<QueueReminderResult> {
  const db = createAdminClient();
  const { data: workspace } = await db
    .from("workspaces")
    .select("owner_id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  const ownerId = (workspace as { owner_id?: string } | null)?.owner_id;
  if (!ownerId) return { queued: false, status: "skipped", reason: "Workspace owner not found." };

  const { data: profile } = await db
    .from("whatsapp_profiles")
    .select("phone_e164, verified_at, consented_at, enabled, workflow_reminders")
    .eq("workspace_id", input.workspaceId)
    .eq("user_id", ownerId)
    .maybeSingle();
  const eligibility = canReceiveWorkflowReminder((profile ?? {}) as WhatsAppEligibility);
  if (!eligibility.allowed) return { queued: false, status: "skipped", reason: eligibility.reason };

  const body = sanitizeWhatsAppMessage(input.body);
  if (!body) return { queued: false, status: "skipped", reason: "The WhatsApp message is empty." };
  const idempotencyKey = input.idempotencyKey ??
    `workflow:${input.runId ?? "none"}:${input.stepId ?? input.kind ?? "summary"}`;

  const row = {
    workspace_id: input.workspaceId,
    user_id: ownerId,
    workflow_id: input.workflowId ?? null,
    workflow_run_id: input.runId ?? null,
    step_id: input.stepId ?? null,
    kind: input.kind ?? "workflow_summary",
    recipient_e164: (profile as { phone_e164: string }).phone_e164,
    body,
    template_sid: env.twilioContentReminder || env.twilioContentGenericAlert || null,
    rendered_variables: {},
    idempotency_key: idempotencyKey,
    status: "pending" as const,
  };
  const { data: inserted, error } = await db.from("message_deliveries").insert(row).select("id, status").single();
  if (!error && inserted) {
    return { queued: true, deliveryId: inserted.id as string, status: inserted.status as DeliveryStatus };
  }
  if (error?.code === "23505") {
    const { data: existing } = await db
      .from("message_deliveries")
      .select("id, status")
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existing) {
      return { queued: true, deliveryId: existing.id as string, status: existing.status as DeliveryStatus };
    }
  }
  throw new Error(error?.message ?? "Could not create the WhatsApp delivery record.");
}

export async function drainWhatsAppDeliveries(limit = 25): Promise<{
  examined: number; sent: number; simulated: number; retried: number; failed: number;
}> {
  const db = createAdminClient();
  const now = new Date().toISOString();
  const { data } = await db
    .from("message_deliveries")
    .select("id, recipient_e164, body, template_sid, rendered_variables, attempt_count, status")
    .in("status", ["pending", "retry"])
    .lte("next_attempt_at", now)
    .order("created_at", { ascending: true })
    .limit(limit);
  const rows = (data ?? []) as Array<{
    id: string; recipient_e164: string; body: string; template_sid: string | null;
    rendered_variables: Record<string, string>; attempt_count: number; status: DeliveryStatus;
  }>;
  const result = { examined: rows.length, sent: 0, simulated: 0, retried: 0, failed: 0 };

  for (const row of rows) {
    const attempt = row.attempt_count + 1;
    const { data: claimed } = await db
      .from("message_deliveries")
      .update({ status: "processing", attempt_count: attempt, updated_at: now })
      .eq("id", row.id)
      .eq("status", row.status)
      .select("id")
      .maybeSingle();
    if (!claimed) continue;

    if (!twilioConfigured) {
      await db.from("message_deliveries").update({ status: "simulated", updated_at: now }).eq("id", row.id);
      result.simulated += 1;
      continue;
    }

    try {
      const statusCallback = `${env.appUrl.replace(/\/$/, "")}/api/whatsapp/status`;
      const message = row.template_sid
        ? await client().messages.create({
            from: env.twilioWhatsAppFrom,
            to: `whatsapp:${row.recipient_e164}`,
            contentSid: row.template_sid,
            contentVariables: JSON.stringify(
              Object.keys(row.rendered_variables).length ? row.rendered_variables : { 1: row.body },
            ),
            statusCallback,
          })
        : await client().messages.create({
            from: env.twilioWhatsAppFrom,
            to: `whatsapp:${row.recipient_e164}`,
            body: row.body,
            statusCallback,
          });
      await db.from("message_deliveries").update({
        status: normalizeTwilioStatus(message.status),
        twilio_message_sid: message.sid,
        error_code: null,
        error_message: null,
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      result.sent += 1;
    } catch (error) {
      const failure = error as { status?: number; code?: number | string; message?: string };
      const retryable = (failure.status ?? 500) >= 500 || failure.status === 429;
      const retry = retryable && attempt < MAX_ATTEMPTS;
      await db.from("message_deliveries").update({
        status: retry ? "retry" : "failed",
        error_code: failure.code ? String(failure.code) : null,
        error_message: sanitizeWhatsAppMessage(failure.message ?? "Twilio send failed", 500),
        next_attempt_at: new Date(Date.now() + retryDelayMs(attempt)).toISOString(),
        updated_at: new Date().toISOString(),
      }).eq("id", row.id);
      if (retry) result.retried += 1;
      else result.failed += 1;
    }
  }
  return result;
}

export async function applyTwilioStatus(input: {
  messageSid: string; status: DeliveryStatus; errorCode?: string | null; errorMessage?: string | null;
}): Promise<boolean> {
  const db = createAdminClient();
  const { data: row } = await db
    .from("message_deliveries")
    .select("id, status")
    .eq("twilio_message_sid", input.messageSid)
    .maybeSingle();
  if (!row) return false;
  const status = nextDeliveryStatus(row.status as DeliveryStatus, input.status);
  await db.from("message_deliveries").update({
    status,
    error_code: input.errorCode ?? null,
    error_message: input.errorMessage ? sanitizeWhatsAppMessage(input.errorMessage, 500) : null,
    updated_at: new Date().toISOString(),
  }).eq("id", row.id);
  return true;
}
