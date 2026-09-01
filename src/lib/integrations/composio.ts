import "server-only";

const BASE_URL = "https://backend.composio.dev/api/v3";

type ComposioErrorBody = { error?: { message?: string } | string; message?: string };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error("COMPOSIO_API_KEY is not configured.");
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "x-api-key": key, ...init?.headers },
    signal: init?.signal ?? AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({})) as T & ComposioErrorBody;
  if (!response.ok) {
    const detail = typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(detail ?? body.message ?? `Composio ${response.status}`);
  }
  return body;
}

async function managedAuthConfig(toolkit: string): Promise<string> {
  const current = await api<{ items: Array<{ id: string; status: string; auth_scheme: string }> }>(`/auth_configs?toolkit_slug=${encodeURIComponent(toolkit)}`);
  const existing = current.items.find((item) => item.status === "ENABLED");
  if (existing) return existing.id;
  try {
    const created = await api<{ auth_config: { id: string } }>("/auth_configs", {
      method: "POST",
      body: JSON.stringify({ toolkit: { slug: toolkit }, auth_config: { type: "use_composio_managed_auth", name: `automata-${toolkit}` } }),
    });
    return created.auth_config.id;
  } catch (error) {
    throw new Error(`${toolkit} needs a provider auth configuration. Add its OAuth app or API-key scheme in Composio, then connect again. ${error instanceof Error ? error.message : ""}`.trim());
  }
}

export async function createConnectLink(workspaceId: string, toolkit: string, callbackUrl: string) {
  const authConfigId = await managedAuthConfig(toolkit);
  return api<{ link_token: string; redirect_url: string; connected_account_id: string }>("/connected_accounts/link", {
    method: "POST",
    body: JSON.stringify({ auth_config_id: authConfigId, user_id: workspaceId, callback_url: callbackUrl }),
  });
}

export interface ConnectedToolkit {
  appSlug: string;
  accountId: string;
  status: "connected" | "pending" | "expired";
}

export async function listConnectedToolkits(workspaceId: string): Promise<ConnectedToolkit[]> {
  const results: ConnectedToolkit[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ user_ids: workspaceId, limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await api<{ items: Array<{ id: string; status: string; toolkit: { slug: string } }>; next_cursor: string | null }>(`/connected_accounts?${query}`);
    for (const account of response.items) {
      const status = account.status === "ACTIVE" ? "connected" : new Set(["INITIATED", "INITIALIZING"]).has(account.status) ? "pending" : "expired";
      results.push({ appSlug: account.toolkit.slug, accountId: account.id, status });
    }
    cursor = response.next_cursor;
    if (!cursor) break;
  }
  return results;
}
