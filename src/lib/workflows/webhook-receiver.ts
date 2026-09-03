import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { secretMatches } from "@/lib/secret";
import { claimRun, webhookKey } from "./claim";
import type { TriggerState, WorkflowConfig } from "./types";
import { payloadFields } from "./webhook-fields";

const MAX_BODY_BYTES = 1024 * 1024;
const REPLAY_WINDOW_MS = 5 * 60_000;

interface Row {
  id: string;
  workspace_id: string;
  active: boolean;
  config: WorkflowConfig;
  draft_config?: WorkflowConfig | null;
  trigger_state?: TriggerState | null;
}

const opaque = () => NextResponse.json({ error: "Not found" }, { status: 404 });

export async function receiveWorkflowWebhook(req: NextRequest, id: string, token: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("workflows")
    .select("id, workspace_id, active, config, draft_config, trigger_state")
    .eq("id", id)
    .maybeSingle();
  const row = data as Row | null;
  if (!row) return opaque();

  const published = row.config?.graph;
  const draft = row.draft_config?.graph ?? published;
  const graph = row.active ? published : draft;
  const start = graph?.steps?.[graph?.start ?? ""];
  if (!start || start.type !== "webhook_trigger") return opaque();
  if (!secretMatches(token, String(start.secret ?? ""))) return opaque();

  const contentType = req.headers.get("content-type") ?? "";
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  const raw = await req.text().catch(() => "");
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = raw.trim() ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    payload = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Body must be a JSON object" }, { status: 400 });
  }

  if (!row.active) {
    const fields = payloadFields(payload);
    const receivedAt = new Date().toISOString();
    await admin.from("workflows").update({
      trigger_state: {
        ...(row.trigger_state ?? {}),
        sample: { payload, fields, receivedAt },
      },
    }).eq("id", id);
    return NextResponse.json({ accepted: true, sample: true, fields }, { status: 202 });
  }

  const stamp = Number(req.headers.get("x-webhook-timestamp"));
  if (Number.isFinite(stamp) && stamp > 0) {
    const at = stamp < 1e12 ? stamp * 1000 : stamp;
    if (Math.abs(Date.now() - at) > REPLAY_WINDOW_MS) {
      return NextResponse.json({ error: "Delivery is outside the replay window" }, { status: 408 });
    }
  }
  const delivery = req.headers.get("x-webhook-id") ?? req.headers.get("x-delivery-id") ??
    req.headers.get("x-github-delivery") ?? req.headers.get("idempotency-key") ??
    (typeof payload.id === "string" ? payload.id : null);
  const claim = await claimRun({
    admin,
    workflowId: id,
    workspaceId: row.workspace_id,
    graph: published!,
    input: payload,
    idempotencyKey: webhookKey(delivery, raw),
    mode: "enqueue",
  });
  if (claim.refused?.reason === "insufficient_credits") {
    return NextResponse.json({ error: "Not enough credits" }, { status: 402 });
  }
  if (claim.refused) return NextResponse.json({ error: claim.error }, { status: 502 });
  return NextResponse.json(
    { accepted: true, run_id: claim.runId, duplicate: claim.duplicate },
    { status: 202 },
  );
}
