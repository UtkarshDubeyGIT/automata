import { env, composioConfigured } from "@/lib/env";
import { normalizeComposioTool, TOOLS, type ToolSpec } from "@/lib/workflows/registry";
import { oauthAppCredentials } from "@/lib/social/oauth-apps";
import {
  captionWithWebsiteLink,
  normalizePostMedia,
  type PostMediaAttachment,
  type WebsiteLink,
} from "@/lib/social/post-media";
import { linkedinConnectedAccountId } from "@/lib/social/linkedin-document";
import { uploadToYouTube, videoUrlOf } from "@/lib/social/youtube-upload";
import { publishLinkedInNativePost } from "@/lib/social/linkedin-media";
import {
  parseGoogleSheetTabs,
  parseGoogleSpreadsheets,
  type GoogleSheetTab,
  type GoogleSpreadsheet,
} from "@/lib/social/resource-data";

/**
 * Composio-backed integration layer (API v3, verified live 2026-07-06).
 *
 * Any of Composio's ~1000 toolkits can be connected: ensureAuthConfig(slug)
 * lazily provisions a managed auth config -> connected_accounts/link returns
 * a hosted OAuth URL -> Composio redirects to our callback -> tools/execute
 * runs actions on the user's behalf.
 *
 * Platform ids ARE Composio toolkit slugs. The Composio "user_id" (entity)
 * is our workspace id, so connections belong to the workspace.
 *
 * When COMPOSIO_API_KEY is absent everything degrades to simulation so the
 * Integrations + Scheduler screens still work in preview.
 */

/**
 * The vocabulary — platform ids, names, slug normalisation, catalog categories
 * — lives in `./platforms`, which has no `env` and no client, so a UI file or a
 * pure module can import it without pulling this one in. Re-exported because
 * every existing caller reaches for it here.
 */
export {
  CATALOG_CATEGORIES,
  CHANNEL_NAME,
  normalizeSlug,
  platformMeta,
  slackTarget,
  PLATFORMS,
  SLUG_RE,
  toolkitLogo,
  type Platform,
  type PlatformMeta,
} from "./platforms";
import { normalizeSlug, platformMeta, slackTarget } from "./platforms";

// ---------------------------------------------------------------------------
// Low-level API client
// ---------------------------------------------------------------------------

const BASE = "https://backend.composio.dev/api/v3";

class ComposioError extends Error {
  readonly status: number;
  /** True when the toolkit has no auth config and managed auth is unavailable. */
  readonly needsCredentials: boolean;
  /** True when refusing, but the toolkit would accept a key the user pastes. */
  readonly keyFallback: boolean;

  constructor(
    message: string,
    status: number,
    needsCredentials = false,
    keyFallback = false,
  ) {
    super(message);
    this.status = status;
    this.needsCredentials = needsCredentials;
    this.keyFallback = keyFallback;
  }
}

/**
 * How long any single Composio request may take.
 *
 * There was no ceiling at all before, and `fetch` has none of its own: a
 * provider that accepted the connection and then stopped talking held the
 * calling workflow step open forever. Inside a claimed run that is worse than
 * a failure — the run stays `running`, unrefunded, and nothing reclaims it
 * until its TTL expires.
 */
const API_TIMEOUT_MS = 30_000;

export interface ApiOptions {
  timeoutMs?: number;
  /**
   * Extra attempts after the first. ONLY for idempotent calls — a read, a
   * catalog lookup. Never a publish or any other write: a request that timed
   * out may well have succeeded at the provider, and retrying it posts twice.
   */
  retries?: number;
  /**
   * Pinned version of tool/action to execute. Defaults to "latest".
   */
  version?: string;
}

export async function composioApi<T>(
  path: string,
  init?: RequestInit,
  opts?: ApiOptions,
): Promise<T> {
  return api<T>(path, init, opts);
}

async function api<T>(path: string, init?: RequestInit, opts?: ApiOptions): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? API_TIMEOUT_MS;
  const attempts = 1 + Math.max(0, opts?.retries ?? 0);
  let last: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.composioKey,
          ...init?.headers,
        },
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (!res.ok) {
        throw new ComposioError(
          body.error?.message ?? `Composio ${res.status}`,
          res.status,
        );
      }
      return body as T;
    } catch (err) {
      last = err;
      // A 4xx is the provider's considered answer, not a blip. Retrying it
      // burns the deadline and arrives at the same rejection.
      if (err instanceof ComposioError && err.status < 500) throw err;
      if (attempt === attempts - 1) break;
    }
  }

  if (last instanceof ComposioError) throw last;
  const name = (last as { name?: string } | undefined)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    throw new ComposioError(`Composio did not answer within ${timeoutMs / 1000}s`, 504);
  }
  throw last instanceof Error ? last : new ComposioError(String(last), 502);
}

// ---------------------------------------------------------------------------
// Toolkit catalog
// ---------------------------------------------------------------------------

export interface ToolkitSummary {
  slug: string;
  name: string;
  description: string;
  categories: string[];
  /** Connectable without the user's own developer app. */
  managed: boolean;
  /** Usable without any connection (public APIs). */
  noAuth: boolean;
  toolsCount: number;
  /** What the user will actually be asked for — drives the button's label. */
  connectVia: ConnectMethod;
}

/**
 * What pressing Connect will actually do, from the user's side.
 *
 * The old label was `managed ? "Connect" : "Set up"`, which lumped two
 * completely different situations together: "paste your API key" (~1,205
 * toolkits, doable in a minute) and "wait for us to register a developer app
 * with the provider" (~200, not doable by the user at all). Both said "Set up",
 * and only one of them led anywhere.
 */
export type ConnectMethod =
  /** One tap: Composio hosts the app, or we do, or nothing needs authorizing. */
  | "managed"
  /** The user pastes their own key/token/login into Composio's hosted form. */
  | "key"
  /** Blocked until someone registers a developer app with the provider. */
  | "own_app";

function isSelfServe(scheme: string): boolean {
  return SELF_SERVE_SCHEMES.includes(scheme);
}

/** Do we hold developer-app credentials for this toolkit? */
export function hasOwnOAuthApp(slug: string): boolean {
  // client_id/client_secret is the OAuth2 pair every toolkit's creation schema
  // asks for; a toolkit with unusual field names simply reports false here and
  // loses a label nicety, never a connection.
  return oauthAppCredentials(slug, ["client_id", "client_secret"]).credentials !== null;
}

/** Pure: catalog facts (plus our own env) in, button label out. */
export function connectMethodOf(input: {
  managed: boolean;
  noAuth: boolean;
  schemes: string[];
  ownApp?: boolean;
}): ConnectMethod {
  if (input.noAuth || input.managed || input.ownApp) return "managed";
  // OAuth may well be on offer, but with no app hosting it the only route the
  // user can finish today is the one they can type into.
  if (input.schemes.some(isSelfServe)) return "key";
  return "own_app";
}

interface RawToolkit {
  name: string;
  slug: string;
  /** Absent on the single-toolkit endpoint; derived from the modes there. */
  no_auth?: boolean;
  auth_schemes?: string[];
  auth_config_details?: { mode: string }[];
  composio_managed_auth_schemes?: string[];
  meta?: {
    description?: string;
    tools_count?: number;
    categories?: { id: string; name: string }[];
  };
}

export interface CatalogPage {
  items: ToolkitSummary[];
  nextCursor: string | null;
  total: number;
}

/**
 * Browse the Composio toolkit catalog. Default order is Composio's own
 * popularity ranking (Gmail, GitHub, Notion... first).
 */
export async function listToolkits(params: {
  search?: string;
  category?: string;
  cursor?: string;
  limit?: number;
}): Promise<CatalogPage> {
  if (!composioConfigured) return { items: [], nextCursor: null, total: 0 };
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit ?? 24));
  if (params.search) qs.set("search", params.search);
  if (params.category && params.category !== "all") qs.set("category", params.category);
  if (params.cursor) qs.set("cursor", params.cursor);

  const res = await api<{
    items: RawToolkit[];
    next_cursor: string | null;
    total_items: number;
  }>(`/toolkits?${qs}`);

  return {
    items: res.items.map(toSummary),
    nextCursor: res.next_cursor,
    total: res.total_items,
  };
}

/** One catalog row, from whichever endpoint the toolkit came back on. */
function toSummary(t: RawToolkit): ToolkitSummary {
  const managed = (t.composio_managed_auth_schemes ?? []).length > 0;
  // The list endpoint states `auth_schemes` outright; the single-toolkit
  // endpoint omits it and spells the same thing out one level down, as the
  // mode of each auth_config_details entry.
  const schemes = t.auth_schemes ?? (t.auth_config_details ?? []).map((d) => d.mode);
  const noAuth = t.no_auth ?? schemes.includes("NO_AUTH");
  return {
    slug: t.slug,
    name: t.name,
    description: t.meta?.description ?? "",
    categories: (t.meta?.categories ?? []).map((c) => c.name),
    managed,
    noAuth,
    toolsCount: t.meta?.tools_count ?? 0,
    connectVia: connectMethodOf({
      managed,
      noAuth,
      schemes,
      ownApp: hasOwnOAuthApp(t.slug),
    }),
  };
}

/**
 * Catalog rows for named toolkits, whatever their popularity.
 *
 * `listToolkits` pages Composio's popularity order 24 at a time, and the
 * Integrations grid can only rank what it has fetched — so a workspace's own
 * connected app fell off the page entirely unless it happened to be in the
 * top 24, and "connected first" quietly meant "connected first, among the
 * popular". Shopify sits outside that page, so a live, ACTIVE connection was
 * invisible until the user searched for it by name.
 *
 * There is no slug filter on the list endpoint (unknown query params are
 * ignored, so asking for one silently returns page 1), hence one read per
 * slug. Callers pass a workspace's connected apps — a handful, not a crowd.
 * A toolkit that fails to load is dropped rather than failing the grid.
 */
export async function listToolkitsBySlug(slugs: string[]): Promise<ToolkitSummary[]> {
  if (!composioConfigured || slugs.length === 0) return [];
  const results = await Promise.all(
    slugs.map((slug) =>
      api<RawToolkit>(`/toolkits/${encodeURIComponent(slug)}`)
        .then((raw) => toSummary({ ...raw, slug: raw.slug || slug }))
        .catch(() => null),
    ),
  );
  return results.filter((row): row is ToolkitSummary => row !== null);
}

// ---------------------------------------------------------------------------
// Dynamic tool listing & search
// ---------------------------------------------------------------------------

const toolCache = new Map<string, { at: number; tools: Array<{ slug: string; spec: ToolSpec }> }>();
const TOOL_CACHE_TTL_MS = 60 * 60 * 1000;
const TOOL_CACHE_MAX_ENTRIES = 200;

function extractRawItems(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  for (const key of ["items", "data", "results", "tools", "toolkits"]) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[]).filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    }
  }
  for (const v of Object.values(record)) {
    if (Array.isArray(v) && v.every((x) => typeof x === "object" && x !== null)) {
      return v as Array<Record<string, unknown>>;
    }
  }
  return [];
}

export async function listToolsForToolkit(
  toolkitSlug: string,
  options?: { version?: string; search?: string; limit?: number },
): Promise<Array<{ slug: string; spec: ToolSpec }>> {
  const normalizedSlug = toolkitSlug.trim().toLowerCase();
  const search = options?.search?.trim() || "";
  const version = options?.version || "latest";
  const limit = options?.limit ?? 100;

  const cacheKey = `${normalizedSlug}|${search}|${version}|${limit}`;
  const hit = toolCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TOOL_CACHE_TTL_MS) {
    return hit.tools;
  }

  // Curated tools matching this toolkit
  const curatedMatches: Array<{ slug: string; spec: ToolSpec }> = [];
  for (const [slug, spec] of Object.entries(TOOLS)) {
    if (spec.app.toLowerCase() === normalizedSlug) {
      if (!search || `${slug} ${spec.desc}`.toLowerCase().includes(search.toLowerCase())) {
        curatedMatches.push({ slug, spec });
      }
    }
  }

  if (!composioConfigured) {
    return curatedMatches;
  }

  try {
    const qs = new URLSearchParams({
      toolkit_slug: normalizedSlug,
      toolkit_versions: version,
      limit: String(limit),
    });
    if (search) qs.set("search", search);

    const body = await api<unknown>(`/tools?${qs}`, undefined, { retries: 1 });
    const rawList = extractRawItems(body);

    const bySlug = new Map<string, { slug: string; spec: ToolSpec }>();

    for (const raw of rawList) {
      const normalized = normalizeComposioTool(raw);
      if (normalized) {
        bySlug.set(normalized.slug, normalized);
      }
    }

    // Curated tools overlay live tools if any were missed or need curated overrides
    for (const item of curatedMatches) {
      const live = bySlug.get(item.slug);
      bySlug.set(item.slug, {
        slug: item.slug,
        spec: {
          ...item.spec,
          ...(live?.spec.version ? { version: live.spec.version } : {}),
          ...(live?.spec.inputSchema ? { inputSchema: live.spec.inputSchema } : {}),
          ...(live?.spec.outputSchema ? { outputSchema: live.spec.outputSchema } : {}),
        },
      });
    }

    const tools = [...bySlug.values()];

    if (toolCache.size >= TOOL_CACHE_MAX_ENTRIES) {
      const oldest = toolCache.keys().next().value;
      if (oldest !== undefined) toolCache.delete(oldest);
    }
    toolCache.set(cacheKey, { at: Date.now(), tools });

    return tools;
  } catch (err) {
    console.error(`[composio] failed to list tools for toolkit ${toolkitSlug}:`, err);
    return curatedMatches;
  }
}

export async function searchDynamicTools(
  query: string,
  options?: { toolkit?: string; limit?: number },
): Promise<Array<{ slug: string; spec: ToolSpec }>> {
  const q = query.trim();
  const toolkit = options?.toolkit?.trim().toLowerCase();
  const limit = options?.limit ?? 100;

  if (toolkit) {
    return listToolsForToolkit(toolkit, { search: q, limit });
  }

  const curatedMatches: Array<{ slug: string; spec: ToolSpec }> = [];
  for (const [slug, spec] of Object.entries(TOOLS)) {
    if (!q || `${slug} ${spec.app} ${spec.desc}`.toLowerCase().includes(q.toLowerCase())) {
      curatedMatches.push({ slug, spec });
    }
  }

  if (!composioConfigured) return curatedMatches.slice(0, limit);

  try {
    const qs = new URLSearchParams({
      search: q,
      toolkit_versions: "latest",
      limit: String(limit),
    });
    const body = await api<unknown>(`/tools?${qs}`, undefined, { retries: 1 });
    const rawList = extractRawItems(body);

    const bySlug = new Map<string, { slug: string; spec: ToolSpec }>();
    for (const raw of rawList) {
      const normalized = normalizeComposioTool(raw);
      if (normalized) bySlug.set(normalized.slug, normalized);
    }
    for (const item of curatedMatches) {
      const live = bySlug.get(item.slug);
      bySlug.set(item.slug, {
        slug: item.slug,
        spec: {
          ...item.spec,
          ...(live?.spec.version ? { version: live.spec.version } : {}),
          ...(live?.spec.inputSchema ? { inputSchema: live.spec.inputSchema } : {}),
          ...(live?.spec.outputSchema ? { outputSchema: live.spec.outputSchema } : {}),
        },
      });
    }

    return [...bySlug.values()].slice(0, limit);
  } catch (err) {
    console.error("[composio] searchDynamicTools failed:", err);
    return curatedMatches.slice(0, limit);
  }
}

export async function findToolSpec(
  slug: string,
  options?: { toolkit?: string; version?: string },
): Promise<ToolSpec | null> {
  const curated = TOOLS[slug];
  if (curated) return curated;
  if (!composioConfigured) return null;

  try {
    const version = options?.version ?? "latest";
    const res = await api<unknown>(`/tools/${encodeURIComponent(slug)}?version=${encodeURIComponent(version)}`, undefined, { retries: 1 });
    const normalized = normalizeComposioTool(res);
    return normalized?.spec ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Auth configs — one per toolkit, provisioned lazily with managed auth
// ---------------------------------------------------------------------------

interface AuthConfigInfo {
  id: string;
  /** OAUTH2 / API_KEY / ... — needed to pick the matching initiation fields. */
  scheme: string;
}

const authConfigCache = new Map<string, AuthConfigInfo>();

/** Create a config and read back the scheme Composio actually assigned. */
async function createAuthConfig(
  slug: string,
  authConfig: Record<string, unknown>,
): Promise<AuthConfigInfo> {
  const created = await api<{ auth_config: { id: string; auth_scheme?: string } }>(
    `/auth_configs`,
    {
      method: "POST",
      body: JSON.stringify({ toolkit: { slug }, auth_config: authConfig }),
    },
  );
  let scheme = created.auth_config.auth_scheme;
  if (!scheme) {
    const detail = await api<{ auth_scheme: string }>(
      `/auth_configs/${created.auth_config.id}`,
    );
    scheme = detail.auth_scheme;
  }
  return { id: created.auth_config.id, scheme };
}

/**
 * Pick or provision the auth config used to connect a toolkit. OAuth wins
 * wherever the provider offers it.
 *
 * Connecting through a non-OAuth config makes Composio's hosted page demand a
 * secret instead of showing the provider's login, so the order is:
 *
 *   1. an OAuth config that already exists (our own developer app first);
 *   2. create one from our own developer app, when credentials are configured
 *      — also the ONLY way to get non-default scopes, e.g. LinkedIn's
 *      `w_organization_social` for posting as a company page;
 *   3. create one on Composio's shared developer app, where offered;
 *   4. a non-OAuth config a human deliberately created — respected so an
 *      existing API-key setup keeps working;
 *   5. for an OAuth-capable toolkit with nothing to connect through, refuse,
 *      naming the env vars that would fix it;
 *   6. for a toolkit with NO OAuth at all, provision a credential-free config
 *      so the user can paste their own key into Composio's hosted form.
 *
 * What this deliberately never does is AUTO-CREATE a non-OAuth config for a
 * toolkit that supports OAuth. That silent downgrade is why "Connect Shopify"
 * asked for an API key: Composio hosts no Shopify app, so the old fallback
 * provisioned whatever scheme was left rather than saying what was missing.
 * Step 6 is not that fallback returning — it only ever runs where OAuth is not
 * on offer from the provider in the first place, so there is no better screen
 * being skipped past.
 */
async function ensureAuthConfig(
  slug: string,
  opts: { allowKey?: boolean } = {},
): Promise<AuthConfigInfo> {
  // Two different questions get two different cache entries: "connect this"
  // and "connect this, a pasted key is acceptable" can legitimately resolve to
  // different configs, and one must never be served for the other.
  const cacheKey = opts.allowKey ? `${slug}:key` : slug;
  const keyName = keyConfigName(slug);

  const cached = authConfigCache.get(cacheKey);
  if (cached) return cached;

  const remember = (info: AuthConfigInfo) => {
    authConfigCache.set(cacheKey, info);
    return info;
  };

  const existing = await api<{
    items: {
      id: string;
      name: string;
      status: string;
      auth_scheme: string;
      is_composio_managed: boolean;
    }[];
  }>(`/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`);
  const enabled = existing.items.filter((c) => c.status === "ENABLED");

  // 1. Among OAuth configs, the user's own developer app (custom config) beats
  // Composio's shared app — the provider consent screen then shows the user's
  // branding instead of "Composio wants to...", and carries our scopes.
  const oauthConfigs = enabled.filter((c) => isOAuth(c.auth_scheme));
  const oauth = oauthConfigs.find((c) => !c.is_composio_managed) ?? oauthConfigs[0];
  if (oauth) return remember({ id: oauth.id, scheme: oauth.auth_scheme });

  const toolkit = await toolkitAuth(slug);
  const oauthMode = preferredOAuthMode(toolkit);

  if (oauthMode) {
    // 2. Our own developer app. Checked before managed auth because a managed
    // config can never carry scopes Composio's shared app didn't register.
    const { credentials, missing } = oauthAppCredentials(
      slug,
      oauthMode.creationRequired,
      oauthMode.creationOptional,
    );
    if (credentials) {
      return remember(
        await createAuthConfig(slug, {
          type: "use_custom_auth",
          // Composio validates this key in camelCase even though the rest of
          // the v3 payload is snake_case.
          authScheme: oauthMode.mode,
          credentials,
          name: `growthos-${slug}`,
        }),
      );
    }

    // 3. Composio's shared developer app.
    if (toolkit.managedSchemes.includes(oauthMode.mode)) {
      return remember(
        await createAuthConfig(slug, {
          type: "use_composio_managed_auth",
          name: `growthos-${slug}`,
        }),
      );
    }

    // 4. Explicit human choice in the dashboard — don't break a working setup.
    // Our own key fallback is excluded: counting it here would turn every later
    // plain Connect into the silent downgrade this whole order exists to stop.
    const handMade = enabled.filter((c) => c.name !== keyName);
    if (handMade.length > 0) {
      return remember({ id: handMade[0].id, scheme: handMade[0].auth_scheme });
    }

    // 5. The user has been told a key is what this app takes, and said yes.
    // Never reached for a plain Connect — `allowKey` is only set when the
    // button they pressed said so.
    if (opts.allowKey) {
      const ours = enabled.find((c) => c.name === keyName);
      if (ours) return remember({ id: ours.id, scheme: ours.auth_scheme });
      const selfServe = selfServeMode(toolkit);
      if (selfServe) return remember(await createSelfServeConfig(slug, selfServe.mode));
    }

    // 6. OAuth is possible but unreachable. Say exactly what's missing rather
    // than dropping the user onto an API-key form they never asked for.
    throw new ComposioError(
      `${toolkit.name} supports OAuth but Composio hosts no shared app for it. ` +
        `Register a developer app with ${toolkit.name}, point its redirect URL at ` +
        `${OAUTH_REDIRECT_URL}, then set ${missing.join(" and ")}.`,
      400,
      true,
      selfServeMode(toolkit) !== undefined,
    );
  }

  // No OAuth anywhere in this toolkit — a key the user pastes is the only way in.
  if (enabled.length > 0) {
    return remember({ id: enabled[0].id, scheme: enabled[0].auth_scheme });
  }
  if (toolkit.managedSchemes.length > 0) {
    return remember(
      await createAuthConfig(slug, {
        type: "use_composio_managed_auth",
        name: `growthos-${slug}`,
      }),
    );
  }

  // 6. Self-serve: a config that carries no secret of OURS, so Composio's
  // hosted page can collect the user's own key. This is how the long tail of
  // the catalog connects — roughly 1,200 of ~1,431 toolkits offer no OAuth at
  // all and no developer app exists to register. Refusing them here used to
  // send the user to dashboard.composio.dev, which is our admin panel and
  // which they cannot open: a dead end for every app from PostHog to Printify.
  const selfServe = selfServeMode(toolkit);
  if (selfServe) {
    return remember(await createSelfServeConfig(slug, selfServe.mode));
  }

  throw new ComposioError(
    `${toolkit.name} publishes no way to connect that we can complete. Check the toolkit at dashboard.composio.dev.`,
    400,
    true,
  );
}

/**
 * The non-OAuth config for a toolkit — used ONLY when we already hold a working
 * credential and there is nothing left to authorize.
 *
 * Deliberately not `ensureAuthConfig(slug, { allowKey: true })`. That function
 * ranks OAuth first by design, and rightly so: for a user pressing Connect, an
 * OAuth screen beats a form asking for a secret. But a Shopify App Store
 * install has ALREADY finished OAuth on our own routes, so returning the OAuth
 * config there would start a second consent round-trip for access the merchant
 * just granted. This is the one caller that wants the key-shaped config, and
 * asking for it explicitly keeps `ensureAuthConfig`'s ordering intact.
 */
async function ensureAdoptableAuthConfig(slug: string): Promise<AuthConfigInfo> {
  const cacheKey = `${slug}:adopt`;
  const cached = authConfigCache.get(cacheKey);
  if (cached) return cached;
  const remember = (info: AuthConfigInfo) => {
    authConfigCache.set(cacheKey, info);
    return info;
  };

  const existing = await api<{
    items: { id: string; name: string; status: string; auth_scheme: string }[];
  }>(`/auth_configs?toolkit_slug=${encodeURIComponent(slug)}`);
  const usable = existing.items.filter((c) => c.status === "ENABLED" && !isOAuth(c.auth_scheme));

  // Our own key config first, then any a human made. Both accept a credential;
  // preferring ours keeps repeated installs on one config rather than fanning
  // connections across whichever one happened to sort first.
  const ours = usable.find((c) => c.name === keyConfigName(slug));
  const chosen = ours ?? usable[0];
  if (chosen) return remember({ id: chosen.id, scheme: chosen.auth_scheme });

  const toolkit = await toolkitAuth(slug);
  const mode = selfServeMode(toolkit);
  if (!mode) {
    throw new ComposioError(
      `${toolkit.name} publishes no credential-based way to connect, so a token we already hold cannot be handed over.`,
      400,
    );
  }
  return remember(await createSelfServeConfig(slug, mode.mode));
}

// ---------------------------------------------------------------------------
// Hosted-page skip — auto-submit defaulted connect-time fields
// ---------------------------------------------------------------------------

interface InitiationField {
  name: string;
  default?: string | null;
}

interface AuthMode {
  mode: string;
  /** Fields needed to CREATE a config — i.e. our developer-app credentials. */
  creationRequired: string[];
  creationOptional: string[];
  /** Fields the END USER supplies when connecting (Shopify's store subdomain). */
  initiationRequired: InitiationField[];
}

interface ToolkitAuth {
  name: string;
  /** Schemes Composio hosts its own developer app for. */
  managedSchemes: string[];
  modes: AuthMode[];
}

/**
 * User-delegated OAuth, best first.
 *
 * S2S_OAUTH2 is deliberately excluded: it's a client-credentials grant that
 * authenticates our app rather than the user's account, so it can't stand in
 * for the consent screen that actually delegates access.
 */
const OAUTH_SCHEMES = ["OAUTH2", "OAUTH1", "OAUTH1A"];

function isOAuth(scheme: string): boolean {
  return OAUTH_SCHEMES.includes(scheme);
}

function preferredOAuthMode(toolkit: ToolkitAuth): AuthMode | undefined {
  for (const scheme of OAUTH_SCHEMES) {
    const mode = toolkit.modes.find((m) => m.mode === scheme);
    if (mode) return mode;
  }
  return undefined;
}

/**
 * Schemes a workspace can finish on its own, best first.
 *
 * The test that matters is not the scheme's name but WHO has to produce the
 * secret. These are the modes whose `auth_config_creation` asks for nothing:
 * every value involved is one the user pastes into Composio's hosted form at
 * connect time (`connected_account_initiation`) — their PostHog key, their
 * Mixpanel login, their Commerce Layer client id. We hold none of it.
 *
 * NO_AUTH is on the list because a toolkit with no credentials at all still
 * needs a connected account to execute against; there is simply nothing to
 * type on the way there.
 */
const SELF_SERVE_SCHEMES = [
  "API_KEY",
  "BEARER_TOKEN",
  "BASIC_WITH_JWT",
  "BASIC",
  "NO_AUTH",
  "S2S_OAUTH2",
  "DCR_OAUTH",
];

/**
 * The callback to register on a developer app. Composio's own toolkit schema
 * hands this back as the `oauth_redirect_uri` default, so it is quoted here
 * rather than in prose that can drift — an earlier version of this message
 * named a URL that no longer matches what Composio publishes.
 */
const OAUTH_REDIRECT_URL = "https://backend.composio.dev/api/v1/auth-apps/add";

/**
 * The name we give a config we created purely so the user could paste a key.
 *
 * It exists to be recognisable later: step 4 of `ensureAuthConfig` respects a
 * config a human set up by hand, and must be able to tell that apart from one
 * we minted ourselves for a different question.
 */
function keyConfigName(slug: string): string {
  return `growthos-${slug}-key`;
}

/** A config carrying no secret of ours; Composio's hosted page collects theirs. */
function createSelfServeConfig(slug: string, mode: string): Promise<AuthConfigInfo> {
  return createAuthConfig(slug, {
    type: "use_custom_auth",
    // camelCase, unlike the rest of the snake_case v3 payload — Composio
    // validates this one key differently.
    authScheme: mode,
    // Deliberately empty. Composio creates the config with no credentials and
    // asks the user for theirs when the connection is initiated.
    credentials: {},
    name: keyConfigName(slug),
  });
}

function selfServeMode(toolkit: ToolkitAuth): AuthMode | undefined {
  const usable = toolkit.modes.filter((m) => m.creationRequired.length === 0);
  for (const scheme of SELF_SERVE_SCHEMES) {
    const mode = usable.find((m) => m.mode === scheme);
    if (mode) return mode;
  }
  // An unranked scheme that still asks us for nothing is better than refusing:
  // the worst case is Composio's hosted page saying what it wants.
  return usable[0];
}

const toolkitAuthCache = new Map<string, ToolkitAuth>();

/**
 * A toolkit's auth schema: which schemes it accepts, which of those Composio
 * hosts an app for, and the fields required at each stage. One cached read
 * serves both config provisioning and the hosted-page skip below.
 */
async function toolkitAuth(slug: string): Promise<ToolkitAuth> {
  const cached = toolkitAuthCache.get(slug);
  if (cached) return cached;

  const raw = await api<{
    name: string;
    composio_managed_auth_schemes?: string[];
    auth_config_details?: {
      mode: string;
      fields?: {
        auth_config_creation?: { required?: InitiationField[]; optional?: InitiationField[] };
        connected_account_initiation?: { required?: InitiationField[] };
      };
    }[];
  }>(`/toolkits/${encodeURIComponent(slug)}`);

  const info: ToolkitAuth = {
    name: raw.name,
    managedSchemes: raw.composio_managed_auth_schemes ?? [],
    modes: (raw.auth_config_details ?? []).map((d) => ({
      mode: d.mode,
      creationRequired: (d.fields?.auth_config_creation?.required ?? []).map((f) => f.name),
      creationOptional: (d.fields?.auth_config_creation?.optional ?? []).map((f) => f.name),
      initiationRequired: d.fields?.connected_account_initiation?.required ?? [],
    })),
  };
  toolkitAuthCache.set(slug, info);
  return info;
}

/**
 * Required connect-time fields for a toolkit's auth scheme — e.g. Supabase's
 * Management API "Base URL" (https://api.supabase.com; only self-hosters
 * change it). Composio's hosted connect page always pauses on a form when a
 * toolkit declares such fields, even if values were passed at link creation.
 */
async function initiationFields(slug: string, scheme: string): Promise<InitiationField[]> {
  const toolkit = await toolkitAuth(slug);
  return toolkit.modes.find((m) => m.mode === scheme)?.initiationRequired ?? [];
}

/**
 * Create a connected account directly, supplying the connect-time fields
 * ourselves — the documented v3 route, and the way to skip Composio's hosted
 * form when there is nothing for a human to type on it.
 *
 * This replaces a call to `dashboard.composio.dev/api/trpc/link.submitLink`,
 * the private endpoint the hosted page's own button used. Composio removed
 * that procedure (it answers "No procedure found on path"), so the skip had
 * quietly stopped working and every toolkit went through the extra page.
 *
 * Returns the provider's OAuth URL when consent is still needed, or null when
 * the account went straight to ACTIVE (nothing to authorize).
 */
async function createConnection(
  authConfigId: string,
  entityId: string,
  callbackUrl: string,
  data: Record<string, string>,
): Promise<{ accountId: string; redirectUrl: string | null; active: boolean }> {
  const res = await api<{
    id: string;
    status?: string;
    redirect_url?: string | null;
  }>(`/connected_accounts`, {
    method: "POST",
    body: JSON.stringify({
      auth_config: { id: authConfigId },
      connection: { user_id: entityId, callback_url: callbackUrl, data },
    }),
  });

  if (res.status === "ACTIVE") {
    return { accountId: res.id, redirectUrl: null, active: true };
  }
  if (res.redirect_url) {
    return { accountId: res.id, redirectUrl: res.redirect_url, active: false };
  }
  throw new ComposioError(
    `connected_accounts returned status ${res.status ?? "unknown"} with no redirect`,
    502,
  );
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

export interface ExecuteResponse {
  successful: boolean;
  error?: string | null;
  data?: Record<string, unknown>;
  /** See `PublishRetryDisposition`. Absent means the default, `"retry"`. */
  retry?: "retry" | "never" | "defer";
  /** Opaque resume state for a `"defer"`. */
  resume?: Record<string, string>;
}

/**
 * Raw Composio tool execution for trusted server-side callers (the workflow
 * engine's app_action steps). Callers must gate on `composioConfigured`.
 */
export async function executeTool(
  slug: string,
  entityId: string,
  args: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<ExecuteResponse> {
  return execute(slug, entityId, args, opts);
}

async function execute(
  slug: string,
  entityId: string,
  args: Record<string, unknown>,
  opts?: ApiOptions,
): Promise<ExecuteResponse> {
  return api<ExecuteResponse>(`/tools/execute/${slug}`, {
    method: "POST",
    // Pin the newest tool implementation unless a specific version is requested.
    body: JSON.stringify({ user_id: entityId, arguments: args, version: opts?.version ?? "latest" }),
  }, opts);
}

/** Pull a plausible external id out of a tool response for audit trails. */
function extractId(data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const d = data as { id?: unknown; post_id?: unknown; response_dict?: { id?: unknown } };
  const raw = d.id ?? d.post_id ?? d.response_dict?.id;
  return raw == null ? undefined : String(raw);
}

// ---------------------------------------------------------------------------
// LinkedIn authors — the signed-in member, or a company page they administer
// ---------------------------------------------------------------------------

/** Accepts a bare id or an already-formed URN. */
function orgUrn(pageId: string): string {
  return pageId.startsWith("urn:") ? pageId : `urn:li:organization:${pageId}`;
}

/**
 * Who a LinkedIn post is attributed to — the company page when one is chosen,
 * otherwise the member themselves.
 *
 * Exported because carousels are published outside this module (Composio's
 * LinkedIn toolkit has no document upload), but resolving the author is still
 * a Composio tool call and belongs here with the rest of them.
 */
export async function linkedinAuthorUrn(
  entityId: string,
  pageId?: string,
): Promise<string | null> {
  return pageId ? orgUrn(pageId) : personUrn(entityId);
}

async function personUrn(entityId: string): Promise<string | null> {
  const me = await execute("LINKEDIN_GET_MY_INFO", entityId, {});
  // Tool versions differ: latest returns the raw /v2/me profile
  // ({id: "..."}); older snapshots wrapped it in response_dict.
  const info = (me.data ?? {}) as {
    id?: string;
    response_dict?: { author_id?: string; sub?: string };
  };
  const rawId = info.response_dict?.author_id ?? info.response_dict?.sub ?? info.id;
  if (!rawId) return null;
  return rawId.startsWith("urn:") ? rawId : `urn:li:person:${rawId}`;
}

export interface CompanyPage {
  /** Numeric organization id — pass as `options.pageId` to post as the page. */
  id: string;
  name: string;
}

/**
 * Company pages the connected LinkedIn member administers.
 *
 * Returns [] rather than throwing when the connection lacks the
 * `r_organization_admin` scope — a member connected through Composio's shared
 * app has no page access at all, and that is a normal state, not an error.
 */
export async function linkedinCompanyPages(entityId: string): Promise<CompanyPage[]> {
  if (!composioConfigured) return [];
  try {
    const res = await execute("LINKEDIN_GET_COMPANY_INFO", entityId, {
      role: "ADMINISTRATOR",
      state: "APPROVED",
    });
    if (!res.successful) return [];
    const elements = (res.data as { elements?: unknown[] } | undefined)?.elements ?? [];
    return elements.flatMap((el) => {
      const row = el as { organization?: string; organizationalTarget?: string };
      const urn = row.organization ?? row.organizationalTarget;
      const id = urn?.split(":").pop();
      return id ? [{ id, name: id }] : [];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// GitHub repos — powers the workflow editor's repo picker
// ---------------------------------------------------------------------------

export interface GithubRepo {
  /** "owner/name" — what the picker shows and what fills the owner+repo args. */
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
}

/**
 * Preference list, not an answer — same reasoning as `RealtimeSpec.slugs`
 * (composio-triggers.ts): Composio names actions per toolkit and the exact
 * slug for "list the authenticated user's repos" isn't documented anywhere
 * this codebase can pin to, so it's discovered against the live catalog and
 * cached rather than guessed at.
 */
const GITHUB_REPO_LIST_CANDIDATES = [
  "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
  "GITHUB_LIST_REPOSITORIES_FOR_AUTHENTICATED_USER",
  "GITHUB_LIST_REPOS_FOR_AUTHENTICATED_USER",
  "GITHUB_LIST_REPOSITORIES_ACCESSIBLE_TO_THE_USER_ACCESS_TOKEN",
];

let githubRepoListTool: string | null | undefined;

async function resolveGithubRepoListTool(): Promise<string | null> {
  if (githubRepoListTool !== undefined) return githubRepoListTool;
  // A failed lookup is left uncached — a network blip shouldn't wedge every
  // future call into "no matching action" for the rest of the process.
  //
  // `search` ranks, it does not filter: the one-word query this used to send
  // ("repositories") came back alphabetical and left the action we want off the
  // page entirely, so the picker resolved to null however GitHub was connected.
  // Ask for the action by its full name.
  const res = await api<{ items?: { slug: string }[] }>(
    `/tools?toolkit_slug=github&search=${encodeURIComponent(
      "list repositories for the authenticated user",
    )}&limit=50`,
  );
  const slugs = new Set((res.items ?? []).map((t) => t.slug.toUpperCase()));
  githubRepoListTool =
    GITHUB_REPO_LIST_CANDIDATES.find((c) => slugs.has(c)) ??
    // Composio has renamed these actions before ("...FOR_AUTHENTICATED_USER" ->
    // "...FOR_THE_AUTHENTICATED_USER"). Fall back to shape rather than to null.
    [...slugs].find((s) => /^GITHUB_LIST_REPOS(ITORIES)?_FOR_(THE_)?AUTHENTICATED_USER$/.test(s)) ??
    null;
  return githubRepoListTool;
}

/**
 * Repos the connected GitHub account can act on, newest-updated first.
 *
 * Returns [] on anything short of a clean list — not connected, no matching
 * action in the live catalog, a transient provider error. The workflow
 * editor's picker degrades to the plain owner/repo text fields it sits above,
 * it never blocks on this.
 */
export async function githubRepositories(entityId: string): Promise<GithubRepo[]> {
  if (!composioConfigured) return [];
  try {
    const slug = await resolveGithubRepoListTool();
    if (!slug) return [];
    const res = await execute(slug, entityId, { per_page: 100, sort: "updated" }, { retries: 1 });
    if (!res.successful) return [];
    // Live shape is `{ repositories, has_more_pages }`; `items` and a bare array
    // are the other forms this endpoint has returned. Accept all three.
    const data = res.data as { items?: unknown[]; repositories?: unknown[] } | unknown[] | undefined;
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.repositories)
        ? data.repositories
        : Array.isArray(data?.items)
          ? data.items
          : [];
    return list.flatMap((raw) => {
      const r = raw as {
        full_name?: string;
        name?: string;
        private?: boolean;
        owner?: { login?: string };
      };
      const owner = r.owner?.login;
      const name = r.name;
      if (!owner || !name) return [];
        return [{ fullName: r.full_name ?? `${owner}/${name}`, owner, name, private: !!r.private }];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Google Sheets resources — powers spreadsheet + tab dropdowns in workflows
// ---------------------------------------------------------------------------

export type { GoogleSheetTab, GoogleSpreadsheet } from "@/lib/social/resource-data";

const DEFAULT_GOOGLE_SPREADSHEETS: GoogleSpreadsheet[] = [
  { id: "demo_recruit_emails", name: "Recruit Emails" },
  { id: "demo_growth_report", name: "Weekly Growth Report" },
];

const DEFAULT_GOOGLE_SHEETS: GoogleSheetTab[] = [
  { id: "0", title: "Sheet1" },
  { id: "1", title: "Leads" },
];

const GOOGLE_SPREADSHEET_LIST_CANDIDATES = [
  "GOOGLESHEETS_LIST_SPREADSHEETS",
  "GOOGLESHEETS_SEARCH_SPREADSHEETS",
  "GOOGLESHEETS_LIST_FILES",
  "GOOGLESHEETS_GET_SPREADSHEETS",
];

const GOOGLE_SPREADSHEET_GET_CANDIDATES = [
  "GOOGLESHEETS_GET_SPREADSHEET_INFO",
  "GOOGLESHEETS_GET_SPREADSHEET_METADATA",
  "GOOGLESHEETS_GET_SPREADSHEET",
];

let googleSpreadsheetListTool: string | null | undefined;
let googleSpreadsheetGetTool: string | null | undefined;

async function resolveGoogleSheetsResourceTool(kind: "list" | "get"): Promise<string | null> {
  const cached = kind === "list" ? googleSpreadsheetListTool : googleSpreadsheetGetTool;
  if (cached !== undefined) return cached;
  try {
    const search = kind === "list" ? "list spreadsheets" : "get spreadsheet metadata sheets";
    const res = await api<{ items?: { slug: string }[] }>(
      `/tools?toolkit_slug=googlesheets&search=${encodeURIComponent(search)}&limit=50`,
    );
    const slugs = new Set((res.items ?? []).map((tool) => tool.slug.toUpperCase()));
    const candidates = kind === "list" ? GOOGLE_SPREADSHEET_LIST_CANDIDATES : GOOGLE_SPREADSHEET_GET_CANDIDATES;
    const resolved =
      candidates.find((candidate) => slugs.has(candidate)) ??
      [...slugs].find((slug) =>
        kind === "list"
          ? /^GOOGLESHEETS_/.test(slug) && /(LIST|SEARCH|GET)/.test(slug) && /SPREADSHEETS/.test(slug) && !/(ROW|VALUE|SHEET_BY)/.test(slug)
          : /^GOOGLESHEETS_/.test(slug) && /(GET|FETCH)/.test(slug) && /SPREADSHEET/.test(slug) && /(INFO|META|DETAIL)/.test(slug),
      ) ??
      null;
    if (kind === "list") googleSpreadsheetListTool = resolved;
    else googleSpreadsheetGetTool = resolved;
    return resolved;
  } catch {
    // Catalog discovery can recover on a later request, so do not cache errors.
    return null;
  }
}

/** Spreadsheets visible to the connected Google Sheets account. */
export async function googleSpreadsheets(entityId: string): Promise<GoogleSpreadsheet[]> {
  if (!composioConfigured) return DEFAULT_GOOGLE_SPREADSHEETS;
  try {
    const slug = await resolveGoogleSheetsResourceTool("list");
    if (!slug) return [];
    const res = await execute(slug, entityId, {}, { retries: 1 });
    if (!res.successful) return [];
    return parseGoogleSpreadsheets(res.data);
  } catch {
    return [];
  }
}

/** Tabs inside one spreadsheet, used after the spreadsheet dropdown changes. */
export async function googleSpreadsheetTabs(
  entityId: string,
  spreadsheetId: string,
): Promise<GoogleSheetTab[]> {
  if (!composioConfigured) return DEFAULT_GOOGLE_SHEETS;
  try {
    const slug = await resolveGoogleSheetsResourceTool("get");
    if (!slug) return [];
    const res = await execute(slug, entityId, { spreadsheet_id: spreadsheetId }, { retries: 1 });
    if (!res.successful) return [];
    return parseGoogleSheetTabs(res.data);
  } catch {
    return [];
  }
}

export interface SlackUser {
  id: string;
  name: string;
  realName?: string;
  isBot?: boolean;
}

const SLACK_USER_LIST_CANDIDATES = [
  "SLACK_LIST_USERS",
  "SLACK_USERS_LIST",
  "SLACK_GET_USER_LIST",
  "SLACK_GET_USERS",
];

let slackUserListTool: string | null | undefined;

async function resolveSlackUserListTool(): Promise<string | null> {
  if (slackUserListTool !== undefined) return slackUserListTool;
  try {
    const res = await api<{ items?: { slug: string }[] }>(
      `/tools?toolkit_slug=slack&search=${encodeURIComponent("list users")}&limit=50`,
    );
    const slugs = new Set((res.items ?? []).map((t) => t.slug.toUpperCase()));
    slackUserListTool =
      SLACK_USER_LIST_CANDIDATES.find((c) => slugs.has(c)) ??
      [...slugs].find((s) => /^SLACK_(USERS_LIST|LIST_USERS|GET_USERS)/.test(s)) ??
      null;
    return slackUserListTool;
  } catch {
    return null;
  }
}

const DEFAULT_SLACK_USERS: SlackUser[] = [
  { id: "U012ME", name: "me", realName: "Direct Message to Me" },
  { id: "U034SARAH", name: "sarah", realName: "Sarah Chen" },
  { id: "U056ALEX", name: "alex", realName: "Alex Kumar" },
  { id: "U078DEV", name: "dev-lead", realName: "Dev Team Lead" },
  { id: "U090GROWTH", name: "growth", realName: "Growth Operations" },
];

/**
 * Users/members on the workspace's connected Slack account for direct messaging.
 * Degrades gracefully to simulated members when unconfigured.
 */
export async function slackUsers(entityId: string): Promise<SlackUser[]> {
  if (!composioConfigured) return DEFAULT_SLACK_USERS;
  try {
    const slug = await resolveSlackUserListTool();
    if (!slug) return DEFAULT_SLACK_USERS;
    const res = await execute(slug, entityId, {}, { retries: 1 });
    if (!res.successful) return DEFAULT_SLACK_USERS;
    const data = res.data as
      | { members?: unknown[]; users?: unknown[]; items?: unknown[] }
      | unknown[]
      | undefined;
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.members)
        ? data.members
        : Array.isArray(data?.users)
          ? data.users
          : Array.isArray(data?.items)
            ? data.items
            : [];
    const parsed = list.flatMap((raw) => {
      const u = raw as {
        id?: string;
        name?: string;
        real_name?: string;
        is_bot?: boolean;
        deleted?: boolean;
        profile?: { real_name?: string; display_name?: string };
      };
      if (!u.id || u.deleted) return [];
      const name = u.name || u.profile?.display_name || u.id;
      const realName = u.real_name || u.profile?.real_name || name;
      return [
        {
          id: u.id,
          name,
          realName,
          isBot: !!u.is_bot,
        },
      ];
    });
    return parsed.length > 0 ? parsed : DEFAULT_SLACK_USERS;
  } catch {
    return DEFAULT_SLACK_USERS;
  }
}

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}

const SLACK_CHANNEL_LIST_CANDIDATES = [
  "SLACK_CONVERSATIONS_LIST",
  "SLACK_LIST_CONVERSATIONS",
  "SLACK_LIST_CHANNELS",
  "SLACK_CHANNELS_LIST",
  "SLACK_GET_CHANNELS",
];

let slackChannelListTool: string | null | undefined;

async function resolveSlackChannelListTool(): Promise<string | null> {
  if (slackChannelListTool !== undefined) return slackChannelListTool;
  try {
    const res = await api<{ items?: { slug: string }[] }>(
      `/tools?toolkit_slug=slack&search=${encodeURIComponent("list conversations channels")}&limit=50`,
    );
    const slugs = new Set((res.items ?? []).map((tool) => tool.slug.toUpperCase()));
    slackChannelListTool =
      SLACK_CHANNEL_LIST_CANDIDATES.find((candidate) => slugs.has(candidate)) ??
      [...slugs].find(
        (slug) =>
          /^SLACK_/.test(slug) &&
          /(LIST|GET)/.test(slug) &&
          /(CONVERSATIONS|CHANNELS)/.test(slug) &&
          !/(HISTORY|REPLIES|MEMBERS|MESSAGES)/.test(slug),
      ) ??
      null;
    return slackChannelListTool;
  } catch {
    // Do not cache discovery failures; a later request may succeed.
    return null;
  }
}

const DEFAULT_SLACK_CHANNELS: SlackChannel[] = [
  { id: "C012GENERAL", name: "general", private: false },
  { id: "C034GROWTH", name: "growth", private: false },
  { id: "G056LEADS", name: "leadership", private: true },
];

/** Public and private channels visible to the workspace's connected Slack account. */
export async function slackChannels(entityId: string): Promise<SlackChannel[]> {
  if (!composioConfigured) return DEFAULT_SLACK_CHANNELS;
  try {
    const slug = await resolveSlackChannelListTool();
    if (!slug) return [];
    const res = await execute(
      slug,
      entityId,
      { limit: 200, types: "public_channel,private_channel", exclude_archived: true },
      { retries: 1 },
    );
    if (!res.successful) return [];
    const data = res.data as
      | {
          channels?: unknown[];
          conversations?: unknown[];
          items?: unknown[];
          public_channels?: unknown[];
          private_channels?: unknown[];
        }
      | unknown[]
      | undefined;
    const list: { raw: unknown; privateHint?: boolean }[] = Array.isArray(data)
      ? data.map((raw) => ({ raw }))
      : [
          ...(Array.isArray(data?.channels) ? data.channels.map((raw) => ({ raw })) : []),
          ...(Array.isArray(data?.conversations)
            ? data.conversations.map((raw) => ({ raw }))
            : []),
          ...(Array.isArray(data?.items) ? data.items.map((raw) => ({ raw })) : []),
          ...(Array.isArray(data?.public_channels)
            ? data.public_channels.map((raw) => ({ raw, privateHint: false }))
            : []),
          ...(Array.isArray(data?.private_channels)
            ? data.private_channels.map((raw) => ({ raw, privateHint: true }))
            : []),
        ];
    const seen = new Set<string>();
    return list.flatMap(({ raw, privateHint }) => {
      const channel = raw as {
        id?: string;
        channel_id?: string;
        name?: string;
        channel_name?: string;
        is_private?: boolean;
        is_group?: boolean;
        is_archived?: boolean;
      };
      const id = channel.id ?? channel.channel_id;
      const name = channel.name ?? channel.channel_name;
      if (!id || !name || channel.is_archived || seen.has(id)) return [];
      seen.add(id);
      return [
        {
          id,
          name,
          private: privateHint ?? !!(channel.is_private || channel.is_group),
        },
      ];
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Public provider
// ---------------------------------------------------------------------------

export interface ConnectResult {
  redirectUrl?: string;
  /** Composio connected-account id (known immediately, ACTIVE after OAuth). */
  accountId?: string;
  connected: boolean;
  simulated?: boolean;
  /** Set when the toolkit requires the user's own developer-app credentials. */
  needsCredentials?: boolean;
  /**
   * Set alongside `needsCredentials` when the same toolkit would also accept a
   * key the user pastes. The UI offers that as an explicit second press — it is
   * never taken on the user's behalf.
   */
  keyFallback?: boolean;
  error?: string;
}

export interface ConnectionState {
  /** Toolkit slug. */
  platform: string;
  status: "connected" | "pending" | "disconnected";
  /** null for `disconnected` — there is no live account to name. */
  accountId: string | null;
}

/** One row from Composio's `/connected_accounts` listing. */
export interface RawConnectedAccount {
  id: string;
  status: string;
  toolkit: { slug: string };
}

/**
 * Reduce raw `/connected_accounts` rows into one entry per toolkit slug.
 *
 * An ACTIVE row always wins its slug, however the rows are ordered — the
 * first pass below runs the full list before anything is read back, so an
 * `[EXPIRED, ACTIVE]` pair and an `[ACTIVE, EXPIRED]` pair resolve the same
 * way. INITIATED/INITIALIZING only claims a slug nothing else has yet.
 *
 * A slug whose rows are all dead (EXPIRED/FAILED/INACTIVE — one or several)
 * still gets exactly one entry: `disconnected`, with no account id. Composio
 * saw this workspace try the toolkit and every attempt died, which is worth
 * surfacing distinctly from a toolkit nobody has touched.
 */
export function bucketConnections(items: RawConnectedAccount[]): ConnectionState[] {
  const bySlug = new Map<string, ConnectionState>();
  for (const item of items) {
    const slug = item.toolkit.slug;
    if (item.status === "ACTIVE") {
      bySlug.set(slug, { platform: slug, status: "connected", accountId: item.id });
    } else if (
      // Docs say INITIATED; the live v3 link flow returns INITIALIZING.
      (item.status === "INITIATED" || item.status === "INITIALIZING") &&
      !bySlug.has(slug)
    ) {
      bySlug.set(slug, { platform: slug, status: "pending", accountId: item.id });
    }
  }
  for (const item of items) {
    const slug = item.toolkit.slug;
    if (!bySlug.has(slug)) {
      bySlug.set(slug, { platform: slug, status: "disconnected", accountId: null });
    }
  }
  return [...bySlug.values()];
}

export interface PostInput {
  entityId: string;
  /** Toolkit slug; legacy aliases are normalized internally. */
  platform: string;
  text: string;
  /** Native LinkedIn attachment. `mediaUrl` remains for older workflows and other channels. */
  media?: PostMediaAttachment;
  mediaUrl?: string;
  /** Optional contextual website mention; currently applied to LinkedIn commentary. */
  link?: WebsiteLink;
  /**
   * Platform specifics: reddit.subreddit/title, slack.channel, and pageId for
   * both facebook (page to post to) and linkedin (company page to post AS).
   */
  options?: {
    subreddit?: string;
    title?: string;
    flairId?: string;
    channel?: string;
    /** Slack member id (U…) for a direct message; takes precedence over channel. */
    dmUser?: string;
    /** JSON/editor-friendly alias accepted for webhook-built workflows. */
    dm_user?: string;
    pageId?: string;
    /**
     * Publisher state, not a user setting: a LinkedIn video URN left by an
     * attempt that finished uploading while LinkedIn was still transcoding.
     * `publishDuePosts` writes it back onto the row and hands it in again, so
     * the retry waits for that asset instead of uploading a second copy.
     */
    linkedinVideoUrn?: string;
  };
}

/**
 * What a caller may do about a publish that did not succeed.
 *
 * This exists because "failed" was the only thing the publish boundary could
 * say, and two of the platform paths need to say something else:
 *
 *  - `"never"` — the platform may ALREADY HAVE the content. A YouTube resumable
 *    session that returned 2xx without an id has accepted the bytes and very
 *    likely published a public video; sending it again manufactures duplicates
 *    on the customer's channel. Fail it immediately, do not spend the retry
 *    budget producing more copies.
 *  - `"defer"` — not a failure at all. The work is in flight on the platform's
 *    side (LinkedIn is still transcoding a video we finished uploading). The
 *    row goes back in the queue WITHOUT burning an attempt, and `resume` carries
 *    the state that lets the next sweep pick up where this one stopped instead
 *    of re-uploading from the first byte.
 *
 * `"retry"` is the default and the pre-existing behaviour: transient, back in
 * the queue, attempt counted, ceiling applies.
 */
export type PublishRetryDisposition = "retry" | "never" | "defer";

export interface PostResult {
  ok: boolean;
  externalId?: string;
  simulated?: boolean;
  error?: string;
  retry?: PublishRetryDisposition;
  /**
   * Opaque state to hand back on the next attempt. Merged into the scheduled
   * post's `options`, which is also how it comes back in — see the LinkedIn
   * branch of `dispatch` and `linkedinVideoUrn`.
   */
  resume?: Record<string, string>;
}

/**
 * Read a retry disposition off a THROWN error.
 *
 * The publish paths are split: some branches return `{ successful: false }` and
 * some throw. Both need to be able to say "do not send this again" or "we are
 * waiting, not failing", and an error whose only channel is a string cannot —
 * which is exactly what let a YouTube upload that had already published be
 * retried four more times. Errors that know their own disposition set these
 * properties; anything else falls through to the default.
 */
function publishDisposition(err: unknown): {
  retry?: PublishRetryDisposition;
  resume?: Record<string, string>;
} {
  const candidate = err as { retry?: unknown; resume?: unknown } | null;
  const out: { retry?: PublishRetryDisposition; resume?: Record<string, string> } = {};
  if (candidate?.retry === "never" || candidate?.retry === "defer" || candidate?.retry === "retry") {
    out.retry = candidate.retry;
  }
  if (candidate?.resume && typeof candidate.resume === "object") {
    out.resume = candidate.resume as Record<string, string>;
  }
  return out;
}

class ComposioProvider {
  readonly live = composioConfigured;

  /** Begin OAuth for a workspace + any toolkit. Returns a hosted connect link. */
  async connect(
    entityId: string,
    slug: string,
    callbackUrl: string,
    opts: { allowKey?: boolean } = {},
  ): Promise<ConnectResult> {
    if (!this.live) return { connected: true, simulated: true, accountId: `sim_${slug}` };
    try {
      const normalized = normalizeSlug(slug);
      const authConfig = await ensureAuthConfig(normalized, opts);

      // When every connect-time field either has a default or doesn't exist,
      // supply them ourselves and send the user straight to the provider's
      // OAuth screen instead of Composio's hosted form. Fields without
      // defaults are values only the user has — Shopify's store subdomain, an
      // API key — so those keep the hosted page that asks for them.
      //
      // The account is created ONLY on the branch that uses it. Creating one
      // up front and then taking the other path left an orphan INITIALIZING
      // row on the workspace for every connect.
      try {
        const fields = await initiationFields(normalized, authConfig.scheme);
        if (fields.every((f) => f.default != null)) {
          const data = Object.fromEntries(fields.map((f) => [f.name, f.default as string]));
          const created = await createConnection(authConfig.id, entityId, callbackUrl, data);
          if (created.active) return { connected: true, accountId: created.accountId };
          return {
            connected: false,
            redirectUrl: created.redirectUrl ?? undefined,
            accountId: created.accountId,
          };
        }
      } catch {
        // Any hiccup falls back to the hosted page, which can always finish.
      }

      const link = await api<{
        link_token: string;
        redirect_url: string;
        connected_account_id: string;
      }>(`/connected_accounts/link`, {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: authConfig.id,
          user_id: entityId,
          callback_url: callbackUrl,
        }),
      });

      return {
        connected: false,
        redirectUrl: link.redirect_url,
        accountId: link.connected_account_id,
      };
    } catch (err) {
      const e = err as ComposioError;
      return {
        connected: false,
        error: e.message,
        needsCredentials: e.needsCredentials,
        keyFallback: e.keyFallback,
      };
    }
  }

  /**
   * Every connected account for an entity, including duplicates and dead ones.
   *
   * This MUST read every page. Composio defaults `/connected_accounts` to 10
   * per page, and an unpaginated read silently truncated busy workspaces: a
   * workspace with 13 accounts reported 10, so genuinely connected toolkits
   * (Gmail, Facebook) looked disconnected — and because listConnections feeds
   * syncConnections, the cache then downgraded those rows to `disconnected`
   * and the agents refused to publish through accounts that were live all
   * along. Duplicates make it worse: two rows for one toolkit spend two slots.
   *
   * The page cap is a runaway guard, not a limit — at 100 per page it allows
   * 2000 accounts for one workspace, far past anything real.
   */
  private async rawConnections(entityId: string): Promise<RawConnectedAccount[]> {
    const items: RawConnectedAccount[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 20; page++) {
      const qs = new URLSearchParams({ user_ids: entityId, limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const res = await api<{ items: RawConnectedAccount[]; next_cursor: string | null }>(
        `/connected_accounts?${qs}`,
      );
      items.push(...res.items);
      cursor = res.next_cursor;
      if (!cursor) break;
    }
    return items;
  }

  /**
   * Live connection state for a workspace, one entry per toolkit. A toolkit
   * can accumulate multiple accounts (an abandoned OAuth attempt leaves an
   * INITIATED one behind, a revoked grant leaves an EXPIRED one) — see
   * `bucketConnections` for how those collapse to one entry per slug.
   */
  async listConnections(entityId: string): Promise<ConnectionState[]> {
    if (!this.live) return [];
    return bucketConnections(await this.rawConnections(entityId));
  }

  /**
   * Disconnect a toolkit by deleting ALL of its connected accounts for this
   * entity — the live one plus any stale INITIATED/EXPIRED leftovers, so a
   * dead duplicate can't survive a user's "Disconnect".
   */
  async disconnectPlatform(entityId: string, slug: string): Promise<void> {
    if (!this.live) return;
    const target = normalizeSlug(slug);
    const accounts = (await this.rawConnections(entityId)).filter(
      (a) => a.toolkit.slug === target,
    );
    await Promise.all(
      accounts.map((a) => api(`/connected_accounts/${a.id}`, { method: "DELETE" })),
    );
  }

  /**
   * Register a credential WE obtained as a Composio connected account, with no
   * user-facing round-trip.
   *
   * This is the bridge that keeps one integration out of two halves. ZidaneAI
   * performs Shopify's OAuth itself, because an App Store install starts on
   * Shopify's side and never reaches Composio's redirect URL (see
   * `src/lib/shopify/oauth.ts`). Without this, that install would produce a
   * token sitting in our database that none of the Shopify tools in
   * `workflows/registry.ts` can see — the store would look connected and every
   * workflow would still say "not connected".
   *
   * The field names are NOT hardcoded. Composio declares its own connect-time
   * fields per toolkit and has renamed them before, so the caller receives the
   * live list and maps its values onto it. `fill` returning null means the
   * caller did not recognise what Composio is asking for, and that refuses
   * loudly with the actual names rather than posting a guess that would
   * "succeed" into a connection that cannot execute a single tool.
   */
  async adoptConnection(
    entityId: string,
    slug: string,
    fill: (fields: string[]) => Record<string, string> | null,
  ): Promise<{ accountId: string; simulated?: boolean }> {
    if (!this.live) return { accountId: `sim_${slug}`, simulated: true };

    const normalized = normalizeSlug(slug);
    const authConfig = await ensureAdoptableAuthConfig(normalized);
    const declared = await initiationFields(normalized, authConfig.scheme);
    const names = declared.map((f) => f.name);

    const filled = fill(names);
    if (!filled) {
      throw new ComposioError(
        `Composio's ${normalized} connection asks for ${names.join(", ") || "no fields"}, ` +
          `which this code does not know how to fill. Check the toolkit's ` +
          `connected_account_initiation schema and update the mapping.`,
        502,
      );
    }

    // Anything declared but unfilled falls back to Composio's own default.
    // A field with neither is left out entirely so Composio names it in the
    // error rather than receiving an empty string it would accept.
    const data: Record<string, string> = {};
    for (const field of declared) {
      const value = filled[field.name] ?? field.default;
      if (value != null) data[field.name] = value;
    }
    for (const [key, value] of Object.entries(filled)) data[key] ??= value;

    const created = await createConnection(
      authConfig.id,
      entityId,
      `${env.appUrl}/integrations`,
      data,
    );

    // A credential-based connection has nothing to redirect to. Anything other
    // than ACTIVE means Composio did not accept what we sent, and reporting
    // success on it would hand the user a store that fails on first use.
    if (!created.active) {
      throw new ComposioError(
        `Composio did not activate the ${normalized} connection from the credential we supplied.`,
        502,
      );
    }
    return { accountId: created.accountId };
  }

  /** Publish to a connected social platform. */
  async post(input: PostInput): Promise<PostResult> {
    if (!this.live) {
      return { ok: true, externalId: `sim_${Date.now()}`, simulated: true };
    }
    try {
      const res = await this.dispatch(input);
      if (!res.successful) {
        return {
          ok: false,
          error: res.error ?? "Post failed",
          ...(res.retry ? { retry: res.retry } : {}),
          ...(res.resume ? { resume: res.resume } : {}),
        };
      }
      return { ok: true, externalId: extractId(res.data) };
    } catch (err) {
      // A thrown error may still know whether it is safe to try again — the
      // LinkedIn media path raises a deferral this way rather than unwinding
      // an upload it has already paid for.
      return { ok: false, error: (err as Error).message, ...publishDisposition(err) };
    }
  }


  private async dispatch(input: PostInput): Promise<ExecuteResponse> {
    const { entityId, text, mediaUrl, media, link, options } = input;
    switch (normalizeSlug(input.platform)) {
      case "twitter":
        return execute("TWITTER_CREATION_OF_A_POST", entityId, { text });

      case "linkedin": {
        // Posting as a company page is the same call with a different author
        // URN. It needs the `w_organization_social` scope, which Composio's
        // shared LinkedIn app does not request — so this path only works
        // through our own developer app (see lib/social/oauth-apps.ts).
        const author = options?.pageId
          ? orgUrn(options.pageId)
          : await personUrn(entityId);
        if (!author) return { successful: false, error: "Could not resolve LinkedIn author id" };
        const commentary = captionWithWebsiteLink(text, link);
        const attachment = media ?? normalizePostMedia({ url: mediaUrl });
        if (attachment) {
          const connectedAccountId = await linkedinConnectedAccountId(entityId);
          if (!connectedAccountId) {
            return {
              successful: false,
              error: "No active LinkedIn connection — reconnect the account to publish media.",
            };
          }
          const published = await publishLinkedInNativePost({
            connectedAccountId,
            author,
            commentary,
            media: attachment,
            // Set by a previous attempt that deferred while LinkedIn was still
            // transcoding. It rides in on the post's stored `options`, which is
            // where `publishDuePosts` writes the `resume` state back to.
            ...(options?.linkedinVideoUrn
              ? { resumeVideoUrn: options.linkedinVideoUrn }
              : {}),
          });
          return { successful: true, data: { id: published.id } };
        }
        return execute("LINKEDIN_CREATE_LINKED_IN_POST", entityId, {
          author,
          commentary,
          visibility: "PUBLIC",
        });
      }

      case "facebook": {
        let pageId = options?.pageId;
        if (!pageId) {
          const pages = await execute("FACEBOOK_GET_USER_PAGES", entityId, {});
          const list = (pages.data as { data?: { id?: string }[] })?.data;
          pageId = list?.[0]?.id;
        }
        if (!pageId) return { successful: false, error: "No Facebook page found for this account" };
        return execute("FACEBOOK_CREATE_POST", entityId, {
          page_id: pageId,
          message: text,
          ...(mediaUrl ? { link: mediaUrl } : {}),
        });
      }

      case "instagram": {
        if (!mediaUrl) {
          return { successful: false, error: "Instagram requires an image or video URL" };
        }
        const user = await execute("INSTAGRAM_GET_USER_INFO", entityId, {});
        const igUserId = extractId(user.data);
        if (!igUserId) return { successful: false, error: "Could not resolve Instagram account id" };
        const isVideo = /\.(mp4|mov|webm)(\?|$)/i.test(mediaUrl);
        const container = await execute("INSTAGRAM_CREATE_MEDIA_CONTAINER", entityId, {
          ig_user_id: igUserId,
          caption: text,
          ...(isVideo ? { video_url: mediaUrl, media_type: "REELS" } : { image_url: mediaUrl }),
        });
        const creationId = extractId(container.data);
        if (!container.successful || !creationId) {
          return { successful: false, error: container.error ?? "Failed to create media container" };
        }
        return execute("INSTAGRAM_CREATE_POST", entityId, {
          ig_user_id: igUserId,
          creation_id: creationId,
        });
      }

      case "reddit": {
        if (!options?.subreddit) {
          return { successful: false, error: "Reddit posts need a target subreddit" };
        }
        return execute("REDDIT_CREATE_REDDIT_POST", entityId, {
          subreddit: options.subreddit,
          title: options.title ?? text.slice(0, 120),
          kind: mediaUrl ? "link" : "self",
          ...(mediaUrl ? { url: mediaUrl } : { text }),
          ...(options.flairId ? { flair_id: options.flairId } : {}),
        });
      }

      case "slack":
        return execute("SLACK_SEND_MESSAGE", entityId, {
          channel: slackTarget(options),
          markdown_text: text,
        });

      case "youtube": {
        const videoUrl = videoUrlOf(media, mediaUrl);
        if (!videoUrl) {
          return {
            successful: false,
            error: "YouTube needs a video — attach one to the step, or generate it earlier in the workflow.",
          };
        }
        try {
          const uploaded = await uploadToYouTube({
            entityId,
            text,
            videoUrl,
            title: options?.title,
          });
          return { successful: true, data: { id: uploaded.videoId, url: uploaded.url } };
        } catch (err) {
          // A failed upload is reported, never retried here: a resumable
          // session that got as far as accepting bytes may have published the
          // video even though the response never reached us. That was true and
          // useless while the only thing crossing this boundary was a string —
          // the retry lives one layer up, in `publishDuePosts`. The disposition
          // now travels with the error so the layer that CAN act on it does.
          return {
            successful: false,
            error: (err as Error).message,
            ...publishDisposition(err),
          };
        }
      }

      case "tiktok":
        return {
          successful: false,
          error: `${platformMeta(input.platform)?.name ?? input.platform} publishing needs a video upload flow — not supported yet`,
        };

      default:
        return {
          successful: false,
          error: `Publishing to ${input.platform} isn't supported yet — use a social channel (X, LinkedIn, Facebook, Instagram, Reddit) or Slack`,
        };
    }
  }
}

export const socialProvider = new ComposioProvider();
