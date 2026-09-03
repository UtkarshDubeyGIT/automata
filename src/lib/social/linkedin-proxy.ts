import { env } from "@/lib/env";

const COMPOSIO_V3 = "https://backend.composio.dev/api/v3";
const COMPOSIO_V31 = "https://backend.composio.dev/api/v3.1";

export interface ProxyParameter {
  name: string;
  value: string;
  /** The live REST API currently calls this field `type`, despite SDK docs using `in`. */
  type: "header" | "query";
}

export interface ProxyResponse<T = unknown> {
  status: number;
  data?: T;
  headers?: Record<string, string>;
}

/** Resolve only this workspace's active LinkedIn connection; never read credential fields. */
export async function linkedinConnectedAccountId(
  entityId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  const qs = new URLSearchParams({ user_ids: entityId, limit: "100" });
  const res = await fetcher(`${COMPOSIO_V3}/connected_accounts?${qs}`, {
    headers: { "x-api-key": env.composioKey },
  });
  if (!res.ok) return null;

  const body = (await res.json().catch(() => ({}))) as {
    items?: { id?: string; status?: string; toolkit?: { slug?: string } }[];
  };
  const active = (body.items ?? []).find(
    (account) => account.status === "ACTIVE" && account.toolkit?.slug === "linkedin",
  );
  return active?.id ?? null;
}

/** Send one LinkedIn request while Composio injects and refreshes the OAuth token. */
export async function linkedinProxy<T>(
  input: {
    connectedAccountId: string;
    endpoint: string;
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
    body?: Record<string, unknown>;
    binaryBody?: { url: string; content_type?: string } | { base64: string; content_type?: string };
    parameters?: ProxyParameter[];
  },
  fetcher: typeof fetch = fetch,
): Promise<ProxyResponse<T>> {
  const res = await fetcher(`${COMPOSIO_V31}/tools/execute/proxy`, {
    method: "POST",
    headers: { "x-api-key": env.composioKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: input.endpoint,
      method: input.method,
      connected_account_id: input.connectedAccountId,
      ...(input.body ? { body: input.body } : {}),
      ...(input.binaryBody ? { binary_body: input.binaryBody } : {}),
      ...(input.parameters?.length ? { parameters: input.parameters } : {}),
    }),
  });
  const response = (await res.json().catch(() => ({}))) as ProxyResponse<T> & {
    error?: unknown;
    message?: unknown;
  };
  if (!res.ok) {
    throw new Error(`Composio proxy failed (${res.status}): ${JSON.stringify(response.error ?? response.message ?? "")}`.slice(0, 300));
  }
  return response;
}
