import type { BuildOutput } from "./builder";

export type BuildJobStatus = "queued" | "running" | "completed" | "failed";

export interface BuildJobView {
  id: string;
  status: BuildJobStatus;
  /** Stable server correlation that survives retries and preview/save. */
  correlationId?: string;
  errorCode?: string;
  build?: BuildOutput;
  error?: string;
}

export type BuildStartOutcome =
  | { kind: "accepted"; job: BuildJobView }
  | { kind: "insufficient_credits"; balance: number; cost: number }
  | { kind: "refused"; message?: string }
  | { kind: "unknown"; reason: "timeout" | "gateway" | "network" };

export type BuildPollOutcome =
  | { kind: "job"; job: BuildJobView }
  | { kind: "retry" }
  | { kind: "refused"; message?: string };

const pendingKeys = new Map<string, string>();

function newRequestKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Plain HTTP on a LAN can expose crypto without randomUUID.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Preserve an unanswered enqueue key across component remounts and retries. */
export async function requestWorkflowBuild(
  prompt: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BuildStartOutcome> {
  const requestKey = pendingKeys.get(prompt) ?? newRequestKey();
  pendingKeys.set(prompt, requestKey);
  const outcome = await startWorkflowBuild(prompt, requestKey, fetchImpl);
  if (outcome.kind !== "unknown") pendingKeys.delete(prompt);
  return outcome;
}

export async function startWorkflowBuild(
  prompt: string,
  requestKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BuildStartOutcome> {
  let res: Response;
  try {
    res = await fetchImpl("/api/workflows/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, requestKey }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return {
      kind: "unknown",
      reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
    };
  }

  const data = (await res.json().catch(() => null)) as {
    job?: BuildJobView;
    error?: string;
    balance?: number;
    cost?: number;
  } | null;
  if (!data) return { kind: "unknown", reason: "gateway" };
  if (res.status === 402) {
    return {
      kind: "insufficient_credits",
      balance: data.balance ?? 0,
      cost: data.cost ?? 3,
    };
  }
  if (!res.ok || !data.job) return { kind: "refused", message: data.error };
  return { kind: "accepted", job: data.job };
}

export async function pollWorkflowBuild(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BuildPollOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workflows/build/${jobId}`, {
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { kind: "retry" };
  }
  const data = (await res.json().catch(() => null)) as {
    job?: BuildJobView;
    error?: string;
  } | null;
  if (!data) return { kind: "retry" };
  if (!res.ok || !data.job) return { kind: "refused", message: data.error };
  return { kind: "job", job: data.job };
}

export function resetPendingBuildKeys(): void {
  pendingKeys.clear();
}
