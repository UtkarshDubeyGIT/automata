export type DeliveryStatus =
  | "pending"
  | "processing"
  | "retry"
  | "queued"
  | "sent"
  | "delivered"
  | "read"
  | "undelivered"
  | "failed"
  | "simulated"
  | "skipped";

export interface WhatsAppEligibility {
  phone_e164?: string | null;
  verified_at?: string | null;
  consented_at?: string | null;
  enabled?: boolean | null;
  workflow_reminders?: boolean | null;
}

export function canReceiveWorkflowReminder(profile: WhatsAppEligibility):
  | { allowed: true }
  | { allowed: false; reason: string } {
  if (!/^\+[1-9]\d{7,14}$/.test(profile.phone_e164 ?? "")) {
    return { allowed: false, reason: "Add a valid WhatsApp phone number." };
  }
  if (!profile.verified_at) return { allowed: false, reason: "Verify the WhatsApp phone number." };
  if (!profile.consented_at) return { allowed: false, reason: "WhatsApp consent is required." };
  if (!profile.enabled) return { allowed: false, reason: "WhatsApp is disabled." };
  if (!profile.workflow_reminders) {
    return { allowed: false, reason: "Workflow reminders are disabled." };
  }
  return { allowed: true };
}

const STATUS_RANK: Record<DeliveryStatus, number> = {
  pending: 0,
  processing: 1,
  retry: 1,
  queued: 2,
  sent: 3,
  undelivered: 3,
  failed: 3,
  delivered: 4,
  read: 5,
  simulated: 5,
  skipped: 5,
};

export function nextDeliveryStatus(current: DeliveryStatus, incoming: DeliveryStatus): DeliveryStatus {
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : current;
}

export function normalizeTwilioStatus(status: string | null | undefined): DeliveryStatus {
  switch (status) {
    case "sent": case "delivered": case "read": case "undelivered": case "failed":
      return status;
    case "accepted": case "scheduled": case "queued": default:
      return "queued";
  }
}

export function sanitizeWhatsAppMessage(input: string, maxLength = 1_000): string {
  const plain = input
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.slice(0, maxLength).trimEnd();
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60 * 1_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}
