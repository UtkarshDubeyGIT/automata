import { composioRealtimeConfigured } from "@/lib/env";
import { socialProvider } from "@/lib/social/composio";
import {
  disableTriggerInstance,
  fitConfig,
  missingConfig,
  resolveTriggerTypes,
  upsertTriggerInstance,
} from "@/lib/social/composio-triggers";
import { getTrigger, SIMULATED_APPS, watchValues } from "./registry";
import type { TriggerState, WorkflowConfig } from "./types";
import { setupNotice } from "@/lib/setup-notice";

/**
 * Turning a real-time watch on and off with the automation's own switch.
 *
 * An app-event workflow can be delivered two ways. Polling always works and is
 * up to `interval_minutes` late. A Composio trigger instance pushes the event
 * as it happens, but needs a key, a webhook secret, a slug that exists in the
 * live catalog, and every required config value the trigger type declares.
 *
 * So this NEVER fails the toggle. Whatever it can't arrange, it records as a
 * reason and leaves the workflow on polling — an automation that runs an hour
 * behind is a tradeoff; one that refuses to switch on is a broken product.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from(table: string): any };

export interface WorkflowLike {
  id: string;
  workspace_id: string;
  config: WorkflowConfig;
  trigger_state: TriggerState | null;
}

/** Bring the real-time watch in line with the automation's Active switch. */
export async function syncRealtimeTrigger(
  admin: DbClient,
  row: WorkflowLike,
  active: boolean,
): Promise<TriggerState["realtime"] | undefined> {
  const state = row.trigger_state ?? {};
  const current = state.realtime;

  if (!active) {
    if (current?.instanceId) {
      // Best effort: a watch we fail to stop pushes events for a paused
      // automation, and the inbound route refuses those anyway.
      await disableTriggerInstance(current.instanceId).catch(() => {});
    }
    if (!current) return undefined;
    const next = { mode: "poll" as const, reason: "The automation is paused.", at: now() };
    await write(admin, row.id, state, next);
    return next;
  }

  const graph = row.config?.graph;
  const start = graph?.steps?.[graph?.start ?? ""];
  if (!start || start.type !== "app_event_trigger") return undefined;

  const next = await enable(row, start as Record<string, unknown>);
  await write(admin, row.id, state, next);
  return next;
}

async function enable(
  row: WorkflowLike,
  start: Record<string, unknown>,
): Promise<NonNullable<TriggerState["realtime"]>> {
  const poll = (reason: string) => ({ mode: "poll" as const, reason, at: now() });

  const spec = getTrigger(String(start.event ?? ""));
  if (!spec?.realtime) {
    return poll("This trigger has no real-time watch, so it is checked on a schedule.");
  }
  if (SIMULATED_APPS.has(spec.app) || !socialProvider.live) {
    return poll("Simulated app — nothing to subscribe to.");
  }
  if (!composioRealtimeConfigured) {
    return poll(
      setupNotice(
        "Real-time delivery is not switched on, so this is checked on a schedule.",
        "Set COMPOSIO_WEBHOOK_SECRET to receive events the moment they happen.",
      ),
    );
  }

  try {
    const types = await resolveTriggerTypes(spec.app, spec.realtime.slugs);
    if (!types.length) {
      return poll(`${spec.app} offers no matching real-time event, so this is checked hourly.`);
    }

    const desired = spec.realtime.config?.(watchValues(start)) ?? {};
    // Drop undefined before fitting, so an unset optional watch field doesn't
    // become a null the provider rejects.
    const cleaned = Object.fromEntries(
      Object.entries(desired).filter(([, v]) => v !== undefined && v !== null && v !== ""),
    );

    /*
     * Take the first candidate we can actually satisfy, not simply the first
     * that exists.
     *
     * Several toolkits publish more than one type for the same event, differing
     * only in what they insist on knowing. Linear is the case that forced this:
     * LINEAR_ISSUE_CREATED_TRIGGER requires `team_id`, so a workspace that left
     * Team blank got no real time at all — while LINEAR_PUBLIC_TEAM_ISSUE_CREATED
     * pushes the same event with `team_id` optional. Preference order still
     * wins whenever more than one is satisfiable, so filling Team in keeps the
     * type that also covers private teams.
     */
    let missing: string[] = [];
    for (const type of types) {
      const config = fitConfig(type, cleaned);
      const unmet = missingConfig(type, config);
      if (unmet.length) {
        // Remember the FIRST candidate's shortfall: it is the preferred one, so
        // its missing key is the one worth telling the user to fill in.
        if (!missing.length) missing = unmet;
        continue;
      }
      const { triggerId } = await upsertTriggerInstance(type.slug, row.workspace_id, config);
      return {
        mode: "realtime",
        instanceId: triggerId,
        slug: type.slug,
        // "webhook" is a provider push; "poll" is Composio polling the account
        // every couple of minutes on our behalf. Recorded so the header can
        // stop calling both of them instant.
        channel: type.type === "webhook" ? "webhook" : "poll",
        at: now(),
      };
    }

    return poll(`Real-time needs ${missing.join(", ")}; checking on a schedule instead.`);
  } catch (err) {
    return poll(
      `Couldn't subscribe for real-time events (${
        err instanceof Error ? err.message.slice(0, 120) : "provider error"
      }); checking on a schedule instead.`,
    );
  }
}

/**
 * Composio has stopped watching this workflow, so start checking it again.
 *
 * The sweep deliberately refuses to poll anything it believes is being pushed
 * — a poll keys off the record id and a push off the delivery id, so the same
 * event arriving both ways is two runs. That skip is right, but it trusts
 * `trigger_state` to still describe reality, and it stops being true the
 * moment Composio disables the instance by itself (expired auth, a webhook
 * subscription it can no longer refresh).
 *
 * Nothing then watches the workflow at all: no push, because the instance is
 * gone, and no poll, because we still think it is pushed. Worse, the skip
 * branch CLEARS `lastError` on every pass, so the header goes on reporting a
 * fresh "last checked" against an automation that has silently stopped — the
 * exact failure the rest of this module exists to make impossible.
 *
 * Dropping `instanceId` is what actually restarts the polling, since that is
 * half of the condition the sweep tests. The `cursor` is deliberately left
 * alone: it was set by a real poll and still names a real record, so the next
 * sweep resumes from it rather than baselining — see `untilCursor`.
 */
export async function demoteToPolling(
  admin: DbClient,
  triggerId: string,
  reason: string,
): Promise<string | null> {
  const { data } = await admin
    .from("workflows")
    .select("id, trigger_state")
    .eq("trigger_state->realtime->>instanceId", triggerId)
    .limit(1)
    .maybeSingle();
  const row = data as { id: string; trigger_state: TriggerState | null } | null;
  if (!row) return null;

  const state = row.trigger_state ?? {};
  await admin
    .from("workflows")
    .update({ trigger_state: { ...state, realtime: { mode: "poll", reason, at: now() } } })
    .eq("id", row.id);
  return row.id;
}

async function write(
  admin: DbClient,
  workflowId: string,
  state: TriggerState,
  realtime: TriggerState["realtime"],
): Promise<void> {
  await admin
    .from("workflows")
    .update({ trigger_state: { ...state, realtime } })
    .eq("id", workflowId);
}

function now(): string {
  return new Date().toISOString();
}
