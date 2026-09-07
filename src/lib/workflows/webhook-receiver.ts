import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { secretMatches } from "@/lib/secret";
import { claimRun, kickRun, webhookKey } from "./runtime";
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
        sample: { secret: token, payload, fields, receivedAt },
      },
    }).eq("id", id);
    return NextResponse.json(
      {
        accepted: true,
        status: "sample",
        sample: true,
        fields,
        message: "This automation is paused, so the payload was saved as a sample and no run was started. Switch it on to run it.",
      },
      { status: 202 },
    );
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

  // A queued run would otherwise wait for the next fifteen-minute beat. Start
  // it once the 202 is on the wire; cron remains the recovery path, so a kick
  // that never lands costs nothing but the wait it was trying to save.
  // Duplicates are left alone: the delivery they collapse into was kicked
  // already, and re-driving a finished run is not what the sender asked for.
  if (!claim.duplicate) after(() => kickRun(admin, claim.runId, row.workspace_id));

  return NextResponse.json(
    {
      accepted: true,
      // Three outcomes used to share one bare 202, so a delivery that did
      // nothing looked exactly like one that started work.
      status: claim.duplicate ? "duplicate" : "queued",
      run_id: claim.runId,
      duplicate: claim.duplicate,
      message: claim.duplicate
        ? "This delivery was already received, so it reuses the run it started the first time."
        : "The run has started.",
    },
    { status: 202 },
  );
}
