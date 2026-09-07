import { env } from "@/lib/env";

/**
 * Raw provider REST access through a workspace's Composio connection.
 *
 * Composio's TOOLS are a curated subset of what a connection can actually do,
 * and for three Google toolkits the subset is the wrong shape entirely:
 *
 *   google_analytics       4 tools, all Admin API — no runReport, so not one
 *                          traffic number is readable through them.
 *   googleads              5 tools — campaign lookup and audience lists, no
 *                          reporting endpoint at all.
 *   google_search_console  has the query tool, but not the sitemap-level
 *                          detail some reports want.
 *
 * The SCOPES on those same connections tell a different story:
 * `analytics.readonly`, `adwords`, `webmasters`. The token is allowed to make
 * the calls; only Composio's tool catalog is missing them. So the proxy is not
 * a workaround — it is the supported way to spend a scope the tool list has no
 * entry for, and it keeps every credential inside Composio: we send a URL, and
 * Composio injects and refreshes the OAuth token server-side. We never see,
 * store, or refresh a Google token for any of these.
 *
 * This module was `linkedin-proxy.ts`, which arrived at the same seam from the
 * other direction — LinkedIn's yearly API sunset outran Composio's pinned tool
 * versions. Same mechanism, so it lives in one place now.
 */

const COMPOSIO_V3 = "https://backend.composio.dev/api/v3";
/** The proxy endpoint is v3.1; the rest of the API is v3. Verified live. */
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

/**
 * This workspace's active connection for one toolkit, or null.
 *
 * Returns the connection ID only — never a credential field. Composio keeps
 * the token masked and injects it per request, which is the whole reason a
 * workspace's Google access can be spent by our server without our server
 * ever being able to leak it.
 */
export async function connectedAccountId(
  entityId: string,
  toolkit: string,
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
    (account) => account.status === "ACTIVE" && account.toolkit?.slug === toolkit,
  );
  return active?.id ?? null;
}

export interface ProxyRequest {
  connectedAccountId: string;
  endpoint: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD";
  body?: Record<string, unknown>;
  binaryBody?: { url: string; content_type?: string } | { base64: string; content_type?: string };
  parameters?: ProxyParameter[];
}

/** Send one provider request while Composio injects and refreshes the OAuth token. */
export async function composioProxy<T>(
  input: ProxyRequest,
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
    throw new Error(
      `Composio proxy failed (${res.status}): ${JSON.stringify(response.error ?? response.message ?? "")}`.slice(0, 300),
    );
  }
  return response;
}

/**
 * Proxy that answers null instead of throwing when the workspace simply has
 * not connected the toolkit.
 *
 * Every analytics provider needs exactly this distinction: "not connected" is
 * an ordinary state that means skip this source, while a failed call against a
 * live connection is a real error worth logging. Folding them together is how
 * a sync loop ends up swallowing genuine provider outages.
 */
export async function proxyFor<T>(
  entityId: string,
  toolkit: string,
  request: Omit<ProxyRequest, "connectedAccountId">,
): Promise<ProxyResponse<T> | null> {
  const id = await connectedAccountId(entityId, toolkit);
  if (!id) return null;
  return composioProxy<T>({ ...request, connectedAccountId: id });
}
