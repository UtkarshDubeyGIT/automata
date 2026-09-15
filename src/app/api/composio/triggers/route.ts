import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/server";
import {
  connectedAccountToolkit,
  verifyWebhook,
  type TriggerMessage,
} from "@/lib/social/composio-triggers";
import { markIntegrationExpired } from "@/lib/social/integrations-store";
import { claimRun } from "@/lib/workflows/claim";
import { demoteToPolling } from "@/lib/workflows/realtime";
import { getTrigger } from "@/lib/workflows/registry";
import type { TriggerState, WorkflowConfig } from "@/lib/workflows/types";

/**
 * Composio pushes an event here.
 *
 * One endpoint for every workspace: the webhook subscription is registered
 * once per Composio project, so the delivery itself has to say which
 * automation — or which connection — it belongs to. `metadata.trigger_id` is
 * the instance we created when the workflow was switched on, and it is stored
 * on the workflow.
 *
 * Three event types are handled: `composio.trigger.message` (the common case
 * — a pushed event, enqueues a run), `composio.trigger.disabled` (Composio
 * switched a watch off by itself; demotes that one workflow to polling), and
 * `composio.connected_account.expired` (a connection this workspace holds
 * stopped working, independent of whether a watch was ever created on it;
 * downgrades the workspace's cached Integrations status so the UI shows it
 * before the next live poll would).
 *
 * The delivery id is the idempotency key, so a redelivered event goes through
 * the same claimRun as a poll, a schedule or a manual click, and produces one
 * run and one charge. Nothing here executes the run — it enqueues, exactly
 * like the sweep, and the beat drives it.
 *
 * FAILS CLOSED. Without COMPOSIO_WEBHOOK_SECRET the signature cannot be
 * checked, and an endpoint that starts charged runs against real accounts must
 * not treat "couldn't check" as "fine".
 */
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 512 * 1024;

interface Row {
  id: string;
  workspace_id: string;
  active: boolean;
  config: WorkflowConfig;
  trigger_state: TriggerState | null;
}

export async function POST(req: NextRequest) {
  const raw = await req.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const verdict = verifyWebhook(
    raw,
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    env.composioWebhookSecret,
  );
  if (!verdict.ok) {
    console.warn("[composio/triggers] rejected a delivery:", verdict.reason);
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let message: TriggerMessage;
  try {
    message = JSON.parse(raw) as TriggerMessage;
  } catch {
    return NextResponse.json({ error: "Body must be JSON" }, { status: 400 });
  }

  /*
   * Not about any one trigger instance — a connection this workspace holds
   * stopped working, independent of whether a watch was ever created on it.
   * Has to be handled before the `trigger_id` guard below: this event type
   * carries none, so falling through would answer "no trigger id" and do
   * nothing, on every delivery, forever.
   */
  if (message.type === "composio.connected_account.expired") {
    const accountId = message.metadata?.connected_account_id;
    const workspaceId = message.metadata?.user_id;
    if (!accountId || !workspaceId) {
      return NextResponse.json({ ok: true, ignored: "no connected account id" });
    }
    const platform = await connectedAccountToolkit(accountId);
    if (platform) {
      await markIntegrationExpired(createAdminClient(), workspaceId, platform);
    }
    // No platform resolved is answered 200 too: retrying will not make the
    // lookup succeed, and this is a best-effort cache update, not a charged
    // run — there is nothing here worth Composio backing off the subscription
    // for.
    return NextResponse.json({ ok: true, expired: platform ?? "unknown toolkit" });
  }

  const triggerId = message.metadata?.trigger_id;
  if (!triggerId) {
    return NextResponse.json({ ok: true, ignored: "no trigger id" });
  }

  /*
   * Composio switched this watch off by itself — expired auth, or a webhook
   * subscription it can no longer refresh. (It does NOT send this when we
   * disable a trigger ourselves, so there are no false positives from pausing
   * an automation.)
   *
   * This has to be acted on rather than logged. The sweep skips polling any
   * workflow it believes Composio is watching, so a disabled instance that
   * nobody records leaves the automation with no watcher of any kind, still
   * reporting a healthy "last checked" — it just stops working. Demoting it
   * back to polling costs latency and says why, which is the tradeoff this
   * whole module is built around.
   */
  if (message.type === "composio.trigger.disabled") {
    const demoted = await demoteToPolling(
      createAdminClient(),
      triggerId,
      "Composio stopped watching this account, so it is being checked on a schedule instead. Reconnect the app to get events the moment they happen.",
    );
    return NextResponse.json({ ok: true, demoted: demoted ?? "no workflow for this trigger" });
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("workflows")
    .select("id, workspace_id, active, config, trigger_state")
    .eq("trigger_state->realtime->>instanceId", triggerId)
    .limit(1)
    .maybeSingle();
  const row = data as Row | null;

  // A watch we no longer own, or one whose workflow was deleted. Answer 200:
  // a 4xx here just makes Composio retry a delivery nothing will ever want.
  if (!row) return NextResponse.json({ ok: true, ignored: "no workflow for this trigger" });
  if (!row.active) return NextResponse.json({ ok: true, ignored: "automation is paused" });

  const graph = row.config?.graph;
  const start = graph?.steps?.[graph?.start ?? ""];
  if (!start || start.type !== "app_event_trigger") {
    return NextResponse.json({ ok: true, ignored: "not an app-event automation" });
  }

  const spec = getTrigger(String(start.event ?? ""));
  const payload = message.data ?? {};
  // Map the pushed payload into the trigger's declared event shape, so
  // {{steps.trigger.event.title}} means the same thing whether the event
  // arrived by push or by poll. The raw payload rides along for anything the
  // mapping doesn't name.
  const event = {
    ...(spec?.realtime?.mapEvent?.(payload) ?? spec?.mapRecord?.(payload) ?? payload),
    raw: payload,
  };

  const claim = await claimRun({
    admin,
    workflowId: row.id,
    workspaceId: row.workspace_id,
    graph,
    input: event,
    // The delivery id. Composio retries deliveries; this is what makes a retry
    // resolve to the run that already exists rather than a second one.
    idempotencyKey: `composio:${message.id}`,
    mode: "enqueue",
  });

  if (claim.refused) {
    // Say so, but with a 200: retrying will not conjure credits, and Composio
    // backing off on a workspace's whole subscription helps nobody.
    return NextResponse.json({ ok: false, error: claim.error });
  }

  return NextResponse.json({
    ok: true,
    run: { runId: claim.runId, status: claim.status },
    duplicate: claim.duplicate,
  });
}
