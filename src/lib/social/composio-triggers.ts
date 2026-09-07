import { createHmac, timingSafeEqual } from "crypto";
import { composioApi } from "./composio";
import { setupNotice } from "@/lib/setup-notice";

/**
 * Composio real-time triggers — the push half of "when a GitHub issue is
 * opened".
 *
 * Polling is what the sweep does: correct, but up to `interval_minutes` late,
 * and it costs a provider call per workflow per beat whether anything happened
 * or not. A trigger instance asks Composio to watch the account and POST us
 * the event the moment it occurs.
 *
 * Two things make this safe to layer on top of the polling path rather than
 * replacing it:
 *
 *  - The delivery id is an idempotency key, so a pushed event goes through the
 *    exact same claimRun as everything else and cannot double-fire.
 *  - The trigger SLUGS are discovered at run time, not hardcoded. Composio's
 *    catalog names them per toolkit and they change; guessing would mean
 *    shipping automations that silently 400 on enable. If no slug matches, the
 *    workflow stays on polling and its trigger state says why.
 */

export interface TriggerType {
  slug: string;
  name?: string;
  description?: string;
  /**
   * How Composio delivers this type: `webhook` is a genuine push from the
   * provider, `poll` is Composio polling on the instance's own `interval`
   * (default 2 minutes) and forwarding what it finds.
   *
   * Both are "real time" next to our hourly sweep, and both are subscribed the
   * same way — but they are not the same promise, and the UI said "Runs in
   * real time" for both. Only GitHub, Slack and Linear are pushes; Gmail's and
   * Google Calendar's are Composio-side polls.
   */
  type?: "webhook" | "poll" | string;
  toolkit?: { slug?: string } | string;
  /** JSON-schema-ish description of what the instance needs configuring with. */
  config?: { properties?: Record<string, unknown>; required?: string[] };
}

interface ListResponse {
  items?: TriggerType[];
  data?: TriggerType[];
}

/** Every trigger type a toolkit offers. Cached: the catalog barely moves. */
const catalog = new Map<string, { at: number; types: TriggerType[] }>();
const CATALOG_TTL_MS = 10 * 60_000;

export async function listTriggerTypes(toolkit: string): Promise<TriggerType[]> {
  const cached = catalog.get(toolkit);
  if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.types;
  const res = await composioApi<ListResponse>(
    `/triggers_types?toolkit_slugs=${encodeURIComponent(toolkit)}&limit=100`,
    undefined,
    { retries: 1 },
  );
  const types = res.items ?? res.data ?? [];
  catalog.set(toolkit, { at: Date.now(), types });
  return types;
}

/**
 * The first candidate slug the toolkit actually offers.
 *
 * Candidates are ordered most-preferred first and matched case-insensitively,
 * with a loose fallback so a renamed-but-recognisable slug
 * (GITHUB_ISSUE_ADDED_EVENT → GITHUB_ISSUE_OPENED_EVENT) is still found.
 */
export async function resolveTriggerType(
  toolkit: string,
  candidates: string[],
): Promise<TriggerType | null> {
  return (await resolveTriggerTypes(toolkit, candidates))[0] ?? null;
}

/**
 * EVERY candidate the toolkit offers, best first.
 *
 * The caller can only find out whether a type is usable after fitting the
 * user's `watch_*` values against its config schema — so picking one type here
 * and handing it back was a guess made too early. Linear is the case in point:
 * `LINEAR_ISSUE_CREATED_TRIGGER` resolves first and requires `team_id`, so a
 * workspace that never filled one in fell back to polling even though
 * `LINEAR_PUBLIC_TEAM_ISSUE_CREATED` sits in the same catalog, pushes the same
 * event, and takes `team_id` as optional. Returning the list lets `enable()`
 * walk it and take the first one it can actually satisfy.
 */
export async function resolveTriggerTypes(
  toolkit: string,
  candidates: string[],
): Promise<TriggerType[]> {
  const types = await listTriggerTypes(toolkit);
  if (!types.length) return [];
  const out: TriggerType[] = [];
  const add = (t: TriggerType) => {
    if (!out.some((seen) => seen.slug === t.slug)) out.push(t);
  };
  const bySlug = new Map(types.map((t) => [String(t.slug ?? "").toUpperCase(), t]));
  for (const candidate of candidates) {
    const exact = bySlug.get(candidate.toUpperCase());
    if (exact) add(exact);
  }
  /*
   * Loose: share the toolkit prefix and every distinctive word — but ONLY when
   * exactly one type matches.
   *
   * Ambiguity here is not a near-miss, it is a different automation. Asking for
   * "GOOGLECALENDAR_NEW_CALENDAR_EVENT" reduces to the words CALENDAR and EVENT
   * (NEW is too short to survive the filter), which six of Google Calendar's
   * seven trigger types contain — created, updated, cancelled, starting-soon,
   * sync and change. `find` took whichever came back first, which was
   * EVENT_CANCELED_DELETED, and because it accepts the same `calendarId` config
   * the subscription succeeded: "when an event is added" quietly became "when
   * an event is cancelled", with nothing anywhere saying so.
   *
   * A tie now resolves to null, which is the honest answer — the caller falls
   * back to polling and records a reason the user can read. Renames, which is
   * what this fallback exists for, stay covered: a renamed trigger is one type,
   * not six.
   */
  for (const candidate of candidates) {
    const words = candidate.toUpperCase().split("_").filter((w) => w.length > 3);
    if (!words.length) continue;
    const matches = types.filter((t) => {
      const slug = String(t.slug ?? "").toUpperCase();
      return words.every((w) => slug.includes(w));
    });
    if (matches.length === 1) add(matches[0]);
  }
  return out;
}

/**
 * Keep only the config keys the trigger type actually declares.
 *
 * The registry knows what the user told us to watch ("owner", "repo"); the
 * trigger type knows what it accepts. Sending a key it doesn't know is a 400,
 * and the registry can't be kept in sync with someone else's catalog by hand.
 */
export function fitConfig(
  type: TriggerType,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const properties = type.config?.properties;
  if (!properties || !Object.keys(properties).length) return desired;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(desired)) {
    if (key in properties) out[key] = value;
  }
  return out;
}

/** Which declared-required config keys we have no value for. */
export function missingConfig(type: TriggerType, config: Record<string, unknown>): string[] {
  return (type.config?.required ?? []).filter(
    (key) => config[key] === undefined || config[key] === null || config[key] === "",
  );
}

export interface TriggerInstance {
  triggerId: string;
}

/**
 * Create (or update) the watch. Upsert rather than create, so re-enabling a
 * workflow reuses the instance instead of accumulating one per toggle.
 */
export async function upsertTriggerInstance(
  slug: string,
  userId: string,
  triggerConfig: Record<string, unknown>,
): Promise<TriggerInstance> {
  const res = await composioApi<{ trigger_id?: string; triggerId?: string; id?: string }>(
    `/trigger_instances/${encodeURIComponent(slug)}/upsert`,
    {
      method: "POST",
      body: JSON.stringify({ user_id: userId, trigger_config: triggerConfig }),
    },
  );
  const triggerId = res.trigger_id ?? res.triggerId ?? res.id;
  if (!triggerId) throw new Error("Composio accepted the trigger but returned no id");
  return { triggerId };
}

/** Stop the watch. Disabled rather than deleted, so re-enabling is cheap. */
export async function disableTriggerInstance(triggerId: string): Promise<void> {
  await composioApi(`/trigger_instances/manage/${encodeURIComponent(triggerId)}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "disable" }),
  });
}

/**
 * Point Composio's webhook subscription at this deployment.
 *
 * The URL is registered ONCE PER PROJECT, not per instance — every trigger for
 * every workspace arrives at the same endpoint, which is why the inbound route
 * resolves the workflow from the payload's trigger id. Normally set in the
 * Composio dashboard; exposed here so it can be scripted.
 *
 * The path is `webhook_subscriptions` with an UNDERSCORE. It was written with a
 * hyphen, which 404s — invisible because nothing has ever called this: the
 * subscription was created by hand in the dashboard, so the one line that would
 * have proved the path wrong never ran. Verified against the live v3 API, which
 * answers the underscore form and returns the registered URL and its signing
 * secret.
 */
export async function setWebhookSubscription(url: string): Promise<void> {
  await composioApi("/webhook_subscriptions", {
    method: "POST",
    body: JSON.stringify({ webhook_url: url, type: "trigger" }),
  });
}

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

/** The v3 envelope every trigger delivery arrives in. */
export interface TriggerMessage {
  id: string;
  type: string;
  metadata: {
    trigger_slug?: string;
    trigger_id?: string;
    connected_account_id?: string;
    user_id?: string;
  };
  data: Record<string, unknown>;
  timestamp?: string;
}

/** How stale a delivery may be before it is treated as a replay. */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;

export interface WebhookHeaders {
  id: string | null;
  timestamp: string | null;
  signature: string | null;
}

/**
 * Verify a delivery: HMAC-SHA256 over `{id}.{timestamp}.{rawBody}`, base64,
 * compared in constant time, inside a replay window.
 *
 * Fails closed on a missing secret or a missing header. This endpoint starts
 * charged runs against real accounts, so "we couldn't check" and "it's invalid"
 * have to mean the same thing.
 */
export function verifyWebhook(
  rawBody: string,
  headers: WebhookHeaders,
  secret: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!secret) {
    return {
      ok: false,
      reason: setupNotice("webhook signing is not enabled", "COMPOSIO_WEBHOOK_SECRET is not set"),
    };
  }
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "missing webhook headers" };
  }

  const seconds = Number(headers.timestamp);
  if (!Number.isFinite(seconds)) return { ok: false, reason: "unparseable webhook-timestamp" };
  const at = seconds < 1e12 ? seconds * 1000 : seconds;
  if (Math.abs(now - at) > WEBHOOK_TOLERANCE_MS) {
    return { ok: false, reason: "delivery is outside the replay window" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${headers.id}.${headers.timestamp}.${rawBody}`)
    .digest("base64");

  // The header carries a version prefix ("v1,<sig>"), and may list several.
  const presented = headers.signature
    .split(" ")
    .map((part) => (part.includes(",") ? part.slice(part.indexOf(",") + 1) : part))
    .filter(Boolean);

  const expectedBuf = Buffer.from(expected);
  const matched = presented.some((candidate) => {
    const buf = Buffer.from(candidate);
    return buf.length === expectedBuf.length && timingSafeEqual(buf, expectedBuf);
  });

  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
