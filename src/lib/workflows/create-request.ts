import type { Workflow } from "@/lib/data/workflows";

export type WorkflowCreationOutcome =
  | { kind: "created"; workflow: Workflow; duplicate: boolean }
  | { kind: "refused"; message?: string }
  | { kind: "unknown" };

interface PendingCreation {
  nonce: string;
  promise?: Promise<WorkflowCreationOutcome>;
}

const pending = new Map<string, PendingCreation>();

function newNonce(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    // Plain HTTP on another device may not expose crypto.randomUUID.
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Share one in-flight create and retain its nonce while the outcome is unknown. */
export function requestWorkflowCreation(
  attemptId: string,
  body: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowCreationOutcome> {
  const attempt = pending.get(attemptId) ?? { nonce: newNonce() };
  pending.set(attemptId, attempt);
  if (attempt.promise) return attempt.promise;

  attempt.promise = (async () => {
    let res: Response;
    try {
      res = await fetchImpl("/api/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-workflow-nonce": attempt.nonce },
        body: JSON.stringify(body),
      });
    } catch {
      attempt.promise = undefined;
      return { kind: "unknown" };
    }

    const data = (await res.json().catch(() => null)) as {
      workflow?: Workflow;
      duplicate?: boolean;
      error?: string;
    } | null;
    if (!data) {
      attempt.promise = undefined;
      return { kind: "unknown" };
    }

    pending.delete(attemptId);
    if (!res.ok || !data.workflow) return { kind: "refused", message: data.error };
    return { kind: "created", workflow: data.workflow, duplicate: Boolean(data.duplicate) };
  })();
  return attempt.promise;
}
