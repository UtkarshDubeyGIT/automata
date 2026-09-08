import { socialProvider } from "@/lib/social/composio";
import { claimInstall, readInstall } from "@/lib/shopify/installs";

/**
 * Handing an App Store install to Composio, so the store behaves like any
 * other connected toolkit.
 *
 * ZidaneAI reads Shopify through Composio — every entry in
 * `workflows/registry.ts` is a Composio tool call. The install routes under
 * `api/shopify/*` produce a token Composio has never seen, so without this
 * module a merchant who installed from the App Store would own a store the
 * product cannot read: connected on our side, invisible to every workflow.
 *
 * The token is interchangeable. Shopify's OAuth access token and the Admin API
 * token a merchant pastes from their own store admin are the same kind of
 * credential — both go in `X-Shopify-Access-Token` — which is why Composio's
 * key-shaped Shopify connection accepts one we obtained ourselves.
 */

const SLUG = "shopify";

/**
 * Which of Composio's declared connect-time fields gets the token, and which
 * gets the store.
 *
 * Matched by pattern rather than by an exact name on purpose: Composio owns
 * this schema, has renamed fields before, and reads it live per toolkit. A
 * hardcoded `{ api_key, shop }` would break silently on a rename — the connect
 * would still be created, and every tool call against it would fail later with
 * an error pointing nowhere near here.
 *
 * `shop` may be either the bare subdomain or the full domain depending on what
 * Composio asks for; the name tells us which. Getting this backwards produces
 * `mystore.myshopify.com.myshopify.com`, so it is worth the extra branch.
 */
export function mapConnectionFields(
  fields: string[],
  shop: string,
  accessToken: string,
): Record<string, string> | null {
  const subdomain = shop.replace(/\.myshopify\.com$/, "");
  const data: Record<string, string> = {};

  for (const name of fields) {
    const key = name.toLowerCase();
    if (/token|api_key|apikey|password|secret/.test(key)) {
      data[name] = accessToken;
    } else if (/shop|store|subdomain|domain/.test(key)) {
      // "…_domain" / "…_url" wants the whole host; "shop"/"subdomain" wants
      // the short name the merchant recognises from their admin URL.
      //
      // `subdomain` is checked FIRST because it contains the substring
      // "domain" and would otherwise match the host branch — which yields
      // "mystore.myshopify.com.myshopify.com" once Composio appends the
      // suffix, and a connection that fails on every call.
      const wantsHost = !/subdomain/.test(key) && /domain|url|host/.test(key);
      data[name] = wantsHost ? shop : subdomain;
    }
  }

  // Every declared field must be accounted for. A partial map is the failure
  // worth refusing on: Composio would accept it, the account would go active,
  // and the first tool call would 401 against a store that is genuinely
  // connected. `adoptConnection` turns null into an error naming the fields.
  return fields.every((f) => data[f] !== undefined) ? data : null;
}

/**
 * Attach a stored install to a workspace and register it with Composio.
 *
 * Order matters. The Composio connection is created BEFORE the row is claimed,
 * because a claimed row is what the UI reads as "this store is yours": marking
 * ownership first and failing second would leave a workspace owning a store no
 * workflow can reach, with no button left to retry it. Failing in this order
 * leaves the install unclaimed and the Connect button still live.
 */
export async function attachStore(
  entityId: string,
  workspaceId: string,
  shop: string,
): Promise<{ accountId: string }> {
  const install = await readInstall(shop);
  if (!install) throw new Error(`No stored Shopify install for ${shop}`);
  if (install.workspaceId && install.workspaceId !== workspaceId) {
    throw new Error(`${shop} is already connected to another Automata account`);
  }

  const { accountId } = await socialProvider.adoptConnection(entityId, SLUG, (fields) =>
    mapConnectionFields(fields, shop, install.accessToken),
  );

  const claimed = await claimInstall(shop, workspaceId);
  if (!claimed) throw new Error(`${shop} is already connected to another Automata account`);

  return { accountId };
}
