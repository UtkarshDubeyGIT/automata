/**
 * Bring-your-own OAuth developer apps, keyed by Composio toolkit slug.
 *
 * Composio hosts a shared developer app for only a slice of its catalog
 * (`composio_managed_auth_schemes`). For everything else — Shopify, X, TikTok —
 * OAuth is fully supported by the provider but Composio has no app to offer,
 * so the connect flow falls back to whatever else the toolkit accepts, which
 * is usually an API-key form. Registering our own app here restores OAuth.
 *
 * It is also how a toolkit gets NON-DEFAULT SCOPES. LinkedIn's managed app
 * only grants `w_member_social` (post as the signed-in person). Posting as a
 * company page needs `w_organization_social`, and a scope Composio's shared
 * app never requests can only come from an app we control.
 *
 * Convention — per toolkit slug, per credential field:
 *
 *   COMPOSIO_OAUTH_<SLUG>_<FIELD>
 *
 * where FIELD is the field name Composio itself declares under the toolkit's
 * `auth_config_creation` schema (client_id, client_secret, scopes, ...),
 * uppercased. Examples:
 *
 *   COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID
 *   COMPOSIO_OAUTH_SHOPIFY_CLIENT_SECRET
 *   COMPOSIO_OAUTH_LINKEDIN_CLIENT_ID
 *   COMPOSIO_OAUTH_LINKEDIN_CLIENT_SECRET
 *   COMPOSIO_OAUTH_LINKEDIN_SCOPES=openid,profile,email,w_member_social,w_organization_social,r_organization_admin
 *
 * Nothing is hardcoded per provider: the required field list is read from the
 * live toolkit schema, so a toolkit with unusual OAuth fields works too.
 *
 * Server-only. These are secrets and must never reach a client bundle, which
 * is also why they are read via process.env[name] rather than added to the
 * static `env` object — dynamic lookup is safe precisely because Next.js will
 * not inline it into browser JS.
 */

/** Credential fields that are optional refinements rather than app identity. */
const OPTIONAL_FIELDS = new Set(["scopes", "oauth_redirect_uri"]);

/** `shopify` + `client_id` -> `COMPOSIO_OAUTH_SHOPIFY_CLIENT_ID`. */
export function credentialEnvVar(slug: string, field: string): string {
  const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return `COMPOSIO_OAUTH_${norm(slug)}_${norm(field)}`;
}

export interface OAuthAppLookup {
  /** Credentials to POST as `auth_config.credentials`, when complete. */
  credentials: Record<string, string> | null;
  /** Required env vars that are missing — drives the "how to fix" message. */
  missing: string[];
}

/**
 * Collect our own developer-app credentials for a toolkit.
 *
 * `required`/`optional` come from the toolkit's live `auth_config_creation`
 * schema. A credential set is only usable when every required field is
 * present; a half-filled one is treated as absent rather than sent to
 * Composio to fail there.
 */
export function oauthAppCredentials(
  slug: string,
  required: string[],
  optional: string[] = [],
): OAuthAppLookup {
  const credentials: Record<string, string> = {};
  const missing: string[] = [];

  for (const field of required) {
    const value = process.env[credentialEnvVar(slug, field)]?.trim();
    if (value) credentials[field] = value;
    // `scopes` is declared required by a few toolkits but always ships a
    // sensible default, so never block a connection on it.
    else if (!OPTIONAL_FIELDS.has(field)) missing.push(credentialEnvVar(slug, field));
  }

  for (const field of optional) {
    const value = process.env[credentialEnvVar(slug, field)]?.trim();
    if (value) credentials[field] = value;
  }

  // Nothing configured at all is the normal case (fall back to managed auth);
  // report it as "no credentials" rather than a partial set.
  if (Object.keys(credentials).length === 0) return { credentials: null, missing };
  if (missing.length > 0) return { credentials: null, missing };
  return { credentials, missing: [] };
}
