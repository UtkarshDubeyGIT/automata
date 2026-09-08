import { executeTool, socialProvider } from "@/lib/social/composio";
import { dueSlot, safeTimeZone } from "./blocks";
import { appEventKey, claimRun, scheduleKey } from "./claim";
import { getTrigger, missingWatch, pollMinutes, SIMULATED_APPS, watchValues } from "./registry";
import { executeNativeTool, runsNatively as nativePoll } from "./native-tools";
import type { StepDef, TriggerState, WorkflowConfig } from "./types";

/**
 * The trigger sweep — everything that fires without a person pressing anything.
 *
 * Each pass looks at ACTIVE workflows and handles both self-starting kinds:
 *
 *   app_event_trigger  — poll the app and start a run per NEW record (input =
 *                        the record, exactly like a manual Test but with real
 *                        data).
 *   schedule_trigger   — start a run for each slot the cadence says is owed.
 *
 * Webhook triggers don't appear here: they are pushed to
 * /api/workflows/[id]/webhook by the calling system.
 *
 * Three things changed when runs became exactly-once:
 *
 *  - It no longer starts runs itself. Every fire goes through `claimRun`, which
 *    owns the idempotency key, the charge and the graph snapshot. Two beats
 *    racing a stale lastFiredAt now produce one run because they compute the
 *    same key, not because they take turns.
 *  - It fires ENQUEUED. The sweep's job is to decide that something is due; a
 *    beat is not the right place to hold a publishing workflow open behind an
 *    nginx proxy timeout.
 *  - Trigger bookkeeping goes to `workflows.trigger_state`, not into `config`.
 *    Writing `config: {...row.config, triggerState}` was a whole-object
 *    read-modify-write that silently reverted a graph saved mid-sweep.
 *
 * Simulated apps (no Composio toolkit) only stamp lastCheckedAt — they never
 * self-fire; the Test button demonstrates them with the trigger's sample.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbClient = { from(table: string): any };

interface WfRow {
  id: string;
  workspace_id: string;
  config: WorkflowConfig;
  trigger_state: TriggerState | null;
}

export interface SweepResult {
  /** Active workflows examined. */
  swept: number;
  /** Of those, ones with a self-starting trigger. */
  checked: number;
  /** Runs actually started. */
  fired: number;
  /** Left for the next beat because this one ran out of deadline. */
  deferred: number;
}

/** How many records one poll may fire at once, so a backlog can't stampede. */
const MAX_EVENTS_PER_POLL = 10;

export async function sweepTriggers(
  admin: DbClient,
  opts: { workspaceId?: string; deadline?: number; limit?: number; now?: Date } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString();
  const deadline = opts.deadline ?? Date.now() + 40_000;

  // Oldest-checked first, so a bounded pass still reaches every tenant
  // eventually. The old sweep walked EVERY active workflow in EVERY workspace
  // serially in one request: one slow provider stalled everybody, and the tail
  // of the list was never reached at all.
  let query = admin
    .from("workflows")
    .select("id, workspace_id, config, trigger_state")
    .eq("active", true)
    .order("id", { ascending: true })
    .limit(opts.limit ?? 100);
  if (opts.workspaceId) query = query.eq("workspace_id", opts.workspaceId);
  const { data } = await query;
  const rows = (data as WfRow[]) ?? [];

  const zones = await timezonesFor(admin, rows.map((r) => r.workspace_id));

  const result: SweepResult = { swept: rows.length, checked: 0, fired: 0, deferred: 0 };

  for (const row of rows) {
    if (Date.now() >= deadline) {
      result.deferred++;
      continue;
    }
    const graph = row.config?.graph;
    const start: StepDef | undefined = graph?.steps?.[graph?.start ?? ""];
    if (!start) continue;
    const state = row.trigger_state ?? {};

    // ---- scheduled workflows -------------------------------------------
    if (start.type === "schedule_trigger") {
      result.checked++;
      const zone = zones.get(row.workspace_id) ?? "UTC";
      const slot = dueSlot(start, state.lastFiredAt, now, zone);
      if (!slot) {
        await writeTriggerState(admin, row.id, { ...state, lastCheckedAt: nowIso });
        continue;
      }

      // The key is the SLOT, not the moment. A beat that runs late, or a slot
      // this bounded sweep skipped, still fires that slot exactly once when it
      // is next reached — and two overlapping beats compute the same key.
      let failure: string | undefined;
      let duplicate = false;
      try {
        const claim = await claimRun({
          admin,
          workflowId: row.id,
          workspaceId: row.workspace_id,
          graph,
          input: { scheduledAt: slot.toISOString() },
          idempotencyKey: scheduleKey(slot),
          mode: "enqueue",
        });
        // A refusal (out of credits) must NOT advance the slot: the run never
        // happened, and the user topping up should see it fire.
        if (claim.refused) failure = claim.error;
        duplicate = claim.duplicate;
      } catch (err) {
        failure = err instanceof Error ? err.message : "could not start this run";
      }
      if (!failure && !duplicate) result.fired++;

      await writeTriggerState(admin, row.id, {
        ...state,
        lastCheckedAt: nowIso,
        // Advance to the SLOT, never to `now`. lastFiredAt is "the last slot
        // fired", which is what makes dueness a plain comparison.
        //
        // A duplicate claim advances it too: somebody already fired this slot,
        // so declining to record that just re-derives the same key next beat.
        lastFiredAt: failure ? state.lastFiredAt : slot.toISOString(),
        ...(failure ? { lastError: failure.slice(0, 200) } : { lastError: undefined }),
      });
      continue;
    }

    // ---- app-event workflows -------------------------------------------
    if (start.type !== "app_event_trigger") continue;
    const spec = getTrigger(String(start.event ?? ""));
    if (!spec) continue;

    // A workflow Composio is already watching must NOT also be polled. A poll
    // keys off the record id and a push keys off the delivery id, so the same
    // event arriving both ways is two different idempotency keys — and two
    // runs. Real time wins; the sweep just records that it looked.
    if (state.realtime?.mode === "realtime" && state.realtime.instanceId) {
      // lastError is cleared here because NOTHING else can: realtime.ts's write
      // spreads the old state and the inbound push route never touches
      // trigger_state, so a poll error from before the switch to push would
      // stay on the header forever, on a workflow that is working.
      await writeTriggerState(admin, row.id, {
        ...state,
        lastCheckedAt: nowIso,
        lastError: undefined,
      });
      continue;
    }

    // Honor the trigger's cadence: skip if checked more recently than that.
    // `pollMinutes` is shared with the editor's card and the limitations panel
    // so the cadence shown and the cadence obeyed cannot drift, and applies the
    // 15-minute floor the beat imposes anyway.
    const minutes = pollMinutes(start);
    const last = state.lastCheckedAt;
    if (last && now.getTime() - new Date(last).getTime() < minutes * 60_000 - 30_000) continue;

    result.checked++;
    let cursor = state.cursor;
    let lastError: string | undefined;

    // A trigger that was never told WHAT to watch cannot be polled. Say so in
    // the trigger state instead of calling the provider with no arguments and
    // recording the 404 that inevitably comes back.
    const unset = missingWatch(start);

    if (unset.length) {
      lastError = `Not set up yet — fill in ${unset.map((w) => w.label).join(" and ")}.`;
      // And forget any cursor. A trigger that was never told what to watch
      // cannot have baselined against anything real — the value here is the ""
      // the old failed-poll path wrote after GitHub 404'd on `<repo>`. Left in
      // place it is worse than useless: `untilCursor` reads a cursor it cannot
      // find as "the page moved past it" and returns the WHOLE page, so the
      // first poll after somebody fixes the repo name would fire a run per
      // pre-existing issue. Clearing it here repairs those rows in place, with
      // no migration, and only for triggers that provably never polled.
      cursor = undefined;
    } else if (
      spec.pollTool &&
      // Native apps poll regardless of Composio: Google Business Profile has no
      // toolkit there, so gating it on `socialProvider.live` would leave the one
      // trigger that needs no Composio key switched off without one.
      (nativePoll(spec.app) || (!SIMULATED_APPS.has(spec.app) && socialProvider.live))
    ) {
      try {
        const native = nativePoll(spec.app);
        // Composio's connection listing cannot answer for an app it does not
        // host. `executeNativeTool` reports the same thing more precisely — it
        // knows the difference between never connected, no location, and a
        // grant that expired — so the pre-check is simply skipped there and the
        // real message comes back from the call itself.
        const connected =
          native ||
          (await socialProvider.listConnections(row.workspace_id)).some(
            (c) => c.platform === spec.app && c.status === "connected",
          );
        if (!connected) {
          lastError = `${spec.app} isn't connected — connect it on the Integrations page.`;
        } else {
          const args = spec.pollArgs ? spec.pollArgs(watchValues(start)) : {};
          const res = native
            ? ((await executeNativeTool(spec.pollTool, row.workspace_id, args)) ?? {
                successful: false,
                error: `${spec.pollTool} has no native implementation`,
              })
            : await executeTool(spec.pollTool, row.workspace_id, args, { retries: 1 });
          if (!res.successful) {
            lastError = `Couldn't check for new items: ${String(res.error ?? "the app rejected the request").slice(0, 200)}`;
            // And STOP. A failed poll used to fall through this block with
            // `records = []`, which baselined an unset cursor to "". Because
            // `untilCursor` reads a cursor it cannot find as "the page has moved
            // past it" and hands back the WHOLE page, the next poll that actually
            // succeeded fired MAX_EVENTS_PER_POLL runs for records that were never
            // new — charged, and emailed for real. Leaving the cursor alone keeps
            // it undefined until a poll succeeds and can baseline honestly.
          } else {
            // EVERY new record, not just the newest. The old sweep looked at
            // `records[0]` alone, so anything that arrived between two polls was
            // silently dropped — and on a busy repo or inbox that is most of it.
            const records = recordList(res.data);
            const unseen = untilCursor(records, cursor);
            // Take the OLDEST of the backlog, not the newest. Listings are
            // newest-first, so slicing from the front would fire the recent ones,
            // move the cursor past them, and strand everything older forever.
            // This way a backlog drains in order over successive polls.
            const fresh = unseen.slice(-MAX_EVENTS_PER_POLL);

            if (cursor === undefined) {
              // First poll: baseline only — never replay history as "new".
              //
              // An empty but SUCCESSFUL first poll still baselines, to "".
              // Leaving the cursor undefined meant the first record ever to
              // arrive was treated as history on the next pass and silently
              // skipped. A FAILED poll never reaches here — see above.
              cursor = (records.length ? recordId(records[0]) : null) ?? "";
            } else {
              // Said HERE, not beside the slice: on a first poll `unseen` is the
              // whole page and `fresh` is capped, but the baseline branch above
              // then discards all of it — so promising "they run on the next
              // check" there put an orange banner on a brand-new automation
              // naming runs that were never going to happen.
              if (unseen.length > fresh.length) {
                lastError = `${unseen.length - fresh.length} more waiting — they run on the next check.`;
              }
              // Oldest first, so the cursor only ever moves forward over records
              // that actually fired.
              for (const record of [...fresh].reverse()) {
                if (Date.now() >= deadline) break;
                const id = recordId(record);
                if (!id) continue;
                const event = spec.mapRecord ? spec.mapRecord(record) : record;
                const claim = await claimRun({
                  admin,
                  workflowId: row.id,
                  workspaceId: row.workspace_id,
                  graph,
                  input: event,
                  // Keyed on the RECORD, which makes the cursor advisory rather
                  // than load-bearing: re-reading a record we already fired for
                  // is a duplicate claim, not a second run.
                  idempotencyKey: appEventKey(id),
                  mode: "enqueue",
                });
                if (claim.refused) {
                  lastError = claim.error;
                  break;
                }
                if (!claim.duplicate) result.fired++;
                // Only AFTER it fired. The cursor used to be assigned before the
                // run started and written even when the poll threw, so a failure
                // lost the event permanently.
                cursor = id;
              }
            }
          }
        }
      } catch (err) {
        // The next sweep retries either way, but a trigger that has been
        // failing for a week should be able to say so rather than just looking
        // like an event that never happened.
        lastError = (err as Error).message?.slice(0, 200) ?? "poll failed";
      }
    }

    await writeTriggerState(admin, row.id, {
      ...state,
      lastCheckedAt: nowIso,
      cursor,
      lastError,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------

async function writeTriggerState(
  admin: DbClient,
  workflowId: string,
  state: TriggerState,
): Promise<void> {
  // Only the trigger's own column. The graph the user is editing is not part
  // of this write, so a save landing mid-sweep survives it.
  await admin.from("workflows").update({ trigger_state: state }).eq("id", workflowId);
}

/** Workspace id → the timezone its schedules are expressed in. */
async function timezonesFor(
  admin: DbClient,
  workspaceIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(workspaceIds)];
  if (!unique.length) return new Map();
  const { data } = await admin
    .from("agent_settings")
    .select("workspace_id, timezone")
    .in("workspace_id", unique);
  return new Map(
    ((data as { workspace_id: string; timezone: string | null }[]) ?? []).map((r) => [
      r.workspace_id,
      safeTimeZone(r.timezone),
    ]),
  );
}

/** The first list of record dicts in a provider read response (newest-first). */
function recordList(data: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return [];
  if (Array.isArray(data)) {
    return data.filter((d): d is Record<string, unknown> => !!d && typeof d === "object");
  }
  if (data && typeof data === "object") {
    for (const v of Object.values(data as Record<string, unknown>)) {
      const found = recordList(v, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

/** The newest-first records up to (not including) the one the cursor names. */
function untilCursor(
  records: Record<string, unknown>[],
  cursor: string | undefined,
): Record<string, unknown>[] {
  if (cursor === undefined) return records;
  const index = records.findIndex((r) => recordId(r) === cursor);
  // A cursor we can no longer see means the page has moved past it entirely.
  // Take the page rather than nothing — the per-record idempotency key is what
  // stops anything already fired from firing again.
  return index === -1 ? records : records.slice(0, index);
}

function recordId(rec: Record<string, unknown>): string | null {
  const id = rec.id ?? rec.number ?? rec.order_number ?? rec.review_id;
  return id == null ? null : String(id);
}
