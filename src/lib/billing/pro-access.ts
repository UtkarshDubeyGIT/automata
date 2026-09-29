import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { env } from "@/lib/env";
import { publicUrl } from "@/lib/request";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const PRO_ACCESS_REVIEW_EMAIL = "vinamr@doubtbuddy.in";
export const PRO_ACCESS_CREDITS = 10_000;

export interface ProAccessRequest {
  id: string;
  workspace_id: string;
  requested_by: string;
  requester_email: string;
  workspace_name: string;
  token_hash: string;
  status: "pending" | "approved" | "declined";
  email_status: "pending" | "sent" | "failed";
  notification_status: "pending" | "sent" | "failed";
  notification_attempts: number;
  notification_next_at: string;
  requested_at: string;
  link_expires_at: string;
  decided_at: string | null;
  access_expires_at: string | null;
  expired_at: string | null;
}

export function newReviewToken(): string {
  return randomBytes(32).toString("base64url");
}

export function reviewTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validReviewToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

export async function reviewRequest(token: string): Promise<ProAccessRequest | null> {
  if (!validReviewToken(token)) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin.from("pro_access_requests")
    .select("*").eq("token_hash", reviewTokenHash(token)).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as ProAccessRequest | null) ?? null;
}

export function canReviewRequest(request: ProAccessRequest | null): request is ProAccessRequest {
  return request?.status === "pending" && new Date(request.link_expires_at).getTime() > Date.now();
}

export async function sendProAccessEmail(to: string, subject: string, message: string, idempotencyKey: string): Promise<void> {
  const from = process.env.RESEND_FROM || process.env.EMAIL_FROM;
  if (!env.resendKey || !from) throw new Error("Pro access email is not configured.");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.resendKey}`, "content-type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from, to: [to], subject, text: message }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Email delivery failed (${response.status}).`);
}

export async function emailReviewer(request: ProAccessRequest, token: string): Promise<void> {
  const link = publicUrl(`/pro-access/review?token=${encodeURIComponent(token)}`).toString();
  await sendProAccessEmail(
    PRO_ACCESS_REVIEW_EMAIL,
    `Pro access request: ${request.workspace_name}`,
    `${request.requester_email} requested Pro access for ${request.workspace_name}.\n\nReview and decide: ${link}\n\nThe link expires in seven days. Opening it does not approve the request.`,
    `pro-review:${request.id}:${request.token_hash.slice(0, 16)}`,
  );
}

export async function notifyProAccessDecision(request: ProAccessRequest): Promise<void> {
  const admin = createSupabaseAdminClient();
  if (!admin || request.status === "pending" || request.notification_status === "sent") return;
  const approved = request.status === "approved";
  const subject = approved ? "Your Pro access is active" : "Your Pro access request";
  const text = approved
    ? `Your workspace ${request.workspace_name} now has complimentary Pro access through ${new Date(request.access_expires_at!).toLocaleDateString("en-US", { dateStyle: "long", timeZone: "UTC" })}. We added ${PRO_ACCESS_CREDITS.toLocaleString()} credits once. No payment was taken.\n\nOpen billing: ${publicUrl("/app/billing")}`
    : `Your Pro access request for ${request.workspace_name} was declined. You can submit a new request from billing.\n\nOpen billing: ${publicUrl("/app/billing")}`;
  try {
    await sendProAccessEmail(request.requester_email, subject, text, `pro-decision:${request.id}`);
    await admin.from("pro_access_requests").update({ notification_status: "sent" }).eq("id", request.id);
  } catch (error) {
    console.error("[pro-access] decision email failed", error);
    const attempts = request.notification_attempts + 1;
    const delay = Math.min(60, 5 * 2 ** Math.min(attempts - 1, 4));
    await admin.from("pro_access_requests").update({
      notification_status: "failed",
      notification_attempts: attempts,
      notification_next_at: new Date(Date.now() + delay * 60_000).toISOString(),
    }).eq("id", request.id);
  }
}

export async function maintainProAccess(): Promise<{ expired: number; notified: number }> {
  const admin = createSupabaseAdminClient();
  if (!admin) return { expired: 0, notified: 0 };
  const { data, error } = await admin.rpc("expire_pro_access");
  if (error) throw new Error(error.message);
  const { data: notices, error: noticeError } = await admin.from("pro_access_requests")
    .select("*").neq("status", "pending").neq("notification_status", "sent")
    .lte("notification_next_at", new Date().toISOString())
    .lt("decided_at", new Date(Date.now() - 60_000).toISOString())
    .order("decided_at", { ascending: true }).limit(20);
  if (noticeError) throw new Error(noticeError.message);
  for (const notice of notices ?? []) await notifyProAccessDecision(notice as ProAccessRequest);
  return { expired: Number(data ?? 0), notified: notices?.length ?? 0 };
}
