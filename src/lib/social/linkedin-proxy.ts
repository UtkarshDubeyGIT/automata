/**
 * LinkedIn's slice of the generic Composio proxy (`./composio-proxy`).
 *
 * The mechanism moved out when Google Analytics, Google Ads and Search Console
 * turned out to need the identical thing — a provider REST call made with a
 * workspace's connection, because Composio's curated tool list has no entry for
 * the endpoint. What stays here is only the LinkedIn binding, so existing
 * callers keep their narrower, better-named import.
 */
import {
  composioProxy,
  connectedAccountId,
  type ProxyRequest,
  type ProxyResponse,
} from "./composio-proxy";

export type { ProxyParameter, ProxyResponse } from "./composio-proxy";

/** Resolve only this workspace's active LinkedIn connection; never read credential fields. */
export function linkedinConnectedAccountId(
  entityId: string,
  fetcher: typeof fetch = fetch,
): Promise<string | null> {
  return connectedAccountId(entityId, "linkedin", fetcher);
}

/** Send one LinkedIn request while Composio injects and refreshes the OAuth token. */
export function linkedinProxy<T>(
  input: ProxyRequest,
  fetcher: typeof fetch = fetch,
): Promise<ProxyResponse<T>> {
  return composioProxy<T>(input, fetcher);
}
