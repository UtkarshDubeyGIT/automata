import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { executeStoredRun } from "@/lib/workflows/run-service";
import type { WorkflowGraph } from "@/lib/workflows/types";

type Params = { params: Promise<{ id: string }> };

export const maxDuration = 60;

function matchesToken(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(createHash("sha256").update(token).digest("hex"));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function POST(request: NextRequest, { params }: Params) {
  const admin = createSupabaseAdminClient();
  if (!admin) return NextResponse.json({ error: "Supabase server key is not configured." }, { status: 503 });
  const { id } = await params;
  const token = request.headers.get("x-automata-webhook-key") ?? request.nextUrl.searchParams.get("key") ?? "";
  const { data: workflow } = await admin.from("workflows").select("id,workspace_id,published_version_id,webhook_token_hash,state").eq("id", id).single();
  if (!workflow?.published_version_id || workflow.state !== "active" || !workflow.webhook_token_hash || !matchesToken(token, workflow.webhook_token_hash)) return NextResponse.json({ error: "Webhook not found." }, { status: 404 });
  const raw = await request.text();
  if (raw.length > 1_000_000) return NextResponse.json({ error: "Webhook body is too large." }, { status: 413 });
  let payload: unknown;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { return NextResponse.json({ error: "Webhook body must be valid JSON." }, { status: 400 }); }
  const { data: version } = await admin.from("workflow_versions").select("graph").eq("id", workflow.published_version_id).single();
  if (!version) return NextResponse.json({ error: "Published version is unavailable." }, { status: 410 });
  const delivery = (request.headers.get("x-automata-delivery-id") ?? request.headers.get("x-request-id") ?? randomUUID()).slice(0, 200);
  const idempotencyKey = `webhook:${delivery}`;
  const { data: created, error } = await admin.from("workflow_runs").insert({ workspace_id: workflow.workspace_id, workflow_id: workflow.id, workflow_version_id: workflow.published_version_id, idempotency_key: idempotencyKey, trigger_kind: "webhook", trigger_payload: payload }).select("id").single();
  if (error?.code === "23505") {
    const { data: existing } = await admin.from("workflow_runs").select("id,status,credits_used,pending_approval_id,error_message").eq("workflow_id", workflow.id).eq("idempotency_key", idempotencyKey).single();
    return NextResponse.json({ run: existing, replayed: true });
  }
  if (error || !created) return NextResponse.json({ error: error?.message ?? "Run could not be created." }, { status: 500 });
  try {
    const result = await executeStoredRun(admin, { id: created.id, workspaceId: workflow.workspace_id, graph: version.graph as WorkflowGraph, triggerData: payload });
    return NextResponse.json({ run: result }, { status: result.state === "failed" ? 502 : 200 });
  } catch (runnerError) {
    await admin.from("workflow_runs").update({ status: "failed", error_code: "runner_error", error_message: runnerError instanceof Error ? runnerError.message : "Runner failed", finished_at: new Date().toISOString() }).eq("id", created.id);
    return NextResponse.json({ error: runnerError instanceof Error ? runnerError.message : "Runner failed", runId: created.id }, { status: 500 });
  }
}
