import type { RunStatus } from "./types";

/**
 * Pressing Run — and knowing what actually happened.
 *
 * Both Run buttons (the editor header, and "Run it again" on the attention
 * card) POST to `/api/workflows/[id]/run`, which drives the entire workflow
 * inside the request. Two things about that request are easy to get wrong, and
 * both were, in both call sites:
 *
 *  1. NOT EVERY FAILED FETCH IS A FAILED RUN. The route is allowed 300s
 *     (`maxDuration`), but nginx caps a *public* request at 60s (see
 *     deploy/AGENTS.md — the cron beat only escapes it by hitting
 *     127.0.0.1:3000 directly) and a single `ai_step` may take 60s on its own.
 *     So an ordinary two-AI-step workflow answers the browser with a proxy 504
 *     while it carries on server-side and finishes normally. Reporting that as
 *     "Run failed — please try again" is a lie the user then acts on.
 *
 *  2. THE PRESS AFTER THAT MUST NOT BE A SECOND RUN. The idempotency key is
 *     minted here, per ATTEMPT rather than per click, and is KEPT for as long
 *     as the outcome is unknown — so pressing Run again re-sends the same key
 *     and `claimRun` hands back the run already in flight instead of starting,
 *     charging for, and publishing a second one. The key is retired the moment
 *     the server tells us anything at all, because that is the only point at
 *     which a fresh press can honestly mean a fresh run.
 *
 *     Both call sites used to mint a new uuid on every click under a comment
 *     promising that "a double-click, a retried fetch or an impatient second
 *     press is one run and one charge". That was true of a retried fetch and of
 *     nothing else: two presses were two keys, two claims, two charges and two
 *     real publishes. The in-flight button guard hid it — right up until the
 *     60s cap released the guard on a run that was still going.
 */

/** The client's own patience. Deliberately longer than the route's 300s. */
export const RUN_WAIT_MS = 310_000;

export type RunOutcome =
  /** The server answered with a run. `duplicate` = an earlier press's run. */
  | { kind: "started"; status: RunStatus; error?: string; duplicate: boolean }
  | { kind: "insufficient_credits"; balance: number; cost: number }
  /** Our route answered, in JSON, that it would not start a run. */
  | { kind: "refused"; message?: string }
  /**
   * We never learned the answer. The run may be running, may have finished,
   * may never have started — the Runs list is the only thing that knows.
   */
  | { kind: "unknown"; reason: "timeout" | "gateway" | "network" };

/**
 * Idempotency keys for attempts whose outcome is still unknown, by workflow id.
 *
 * Module-level on purpose: it has to outlive the component, since the whole
 * point is that the *next* press of the button re-uses the key. It only ever
 * holds ids whose last attempt went unanswered.
 */
const pendingKeys = new Map<string, string>();

/**
 * `crypto.randomUUID()` alone is undefined outside a secure context — plain
 * http on a LAN address, which is exactly how someone tests this from their
 * phone — and it throws rather than returning undefined, taking the whole click
 * with it. The server accepts any string and mints its own when the header is
 * missing, so a weaker fallback is strictly better than an exception.
 */
function newKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the timestamp form.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

interface RunResponse {
  run?: { status?: string; error?: string };
  duplicate?: boolean;
  error?: string;
  balance?: number;
  cost?: number;
}

/** POST the run and classify the answer. Never throws. */
export async function requestRun(
  workflowId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RunOutcome> {
  const key = pendingKeys.get(workflowId) ?? newKey();
  pendingKeys.set(workflowId, key);

  let res: Response;
  try {
    res = await fetchImpl(`/api/workflows/${workflowId}/run`, {
      method: "POST",
      headers: { "x-run-nonce": key },
      signal: AbortSignal.timeout(RUN_WAIT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const timedOut = name === "TimeoutError" || name === "AbortError";
    // Aborting the fetch does not abort the run: it is journaled server-side
    // and a beat resumes it. Keep the key.
    return { kind: "unknown", reason: timedOut ? "timeout" : "network" };
  }

  const data = (await res.json().catch(() => null)) as RunResponse | null;
  if (!data) {
    // A body we cannot read is not our route talking — it is the proxy's own
    // 504/502 page, or an empty response. We did not learn the answer either.
    return { kind: "unknown", reason: "gateway" };
  }

  // The server answered. Whatever it said, this attempt is settled and the
  // next press is a new run.
  pendingKeys.delete(workflowId);

  if (res.status === 402) {
    return { kind: "insufficient_credits", balance: data.balance ?? 0, cost: data.cost ?? 2 };
  }
  if (!res.ok || !data.run?.status) {
    return { kind: "refused", message: data.error };
  }
  return {
    kind: "started",
    status: data.run.status as RunStatus,
    error: data.run.error,
    duplicate: Boolean(data.duplicate),
  };
}

/** Test seam — the key map is module state and outlives any one test. */
export function resetPendingKeys(): void {
  pendingKeys.clear();
}
