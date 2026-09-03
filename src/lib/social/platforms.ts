/**
 * The Composio VOCABULARY: platform ids, display names, slug normalisation and
 * the catalog categories. No network, no key, no `env`.
 *
 * This is the half of `composio.ts` that everybody needs and almost nobody
 * needed the rest of. Seven client components (the Integrations screen, the
 * workflow canvas, inspector, step picker, approval card and logo) and five
 * modules documented as pure — `workflows/validate.ts`, `apps.ts`,
 * `preview.ts`, `display.ts`, `blocks.ts` — imported one lookup table or one
 * `normalizeSlug` and inherited the whole ~1200-line API client, its OAuth
 * handshake, its webhook verification and `@/lib/env` with it.
 *
 * That is the trap `src/lib/workflows/AGENTS.md` describes under `apps.ts`:
 * types resolve, `tsc --noEmit` stays green, and the cost lands in the browser
 * bundle. `tests/pure-modules.test.ts` now walks the import graph and fails on
 * it rather than leaving it to be noticed.
 *
 * `composio.ts` re-exports everything here, so this is a move and no importer
 * had to change — but new code should import the narrow one.
 *
 * ONE rule to keep it honest: nothing in this file may import `@/lib/env`, a
 * Supabase client, or anything that does. A constant that needs a key is not a
 * constant, it is configuration, and it belongs on the other side.
 */

export type Platform =
  | "twitter"
  | "linkedin"
  | "facebook"
  | "instagram"
  | "youtube"
  | "reddit"
  | "tiktok"
  | "slack";

export interface PlatformMeta {
  id: Platform;
  name: string;
  description: string;
  /** Social channel (Scheduler/Agent posts here) vs supporting tool. */
  kind: "channel" | "tool";
  /**
   * Whether Composio offers managed OAuth. When false the user must add
   * their own developer-app credentials in the Composio dashboard first.
   */
  managedAuth: boolean;
}

/** Curated channels shown at the top of the Integrations screen. */
export const PLATFORMS: PlatformMeta[] = [
  { id: "facebook", name: "Facebook", description: "Publish to your Facebook pages", kind: "channel", managedAuth: true },
  { id: "instagram", name: "Instagram", description: "Schedule reels & image posts", kind: "channel", managedAuth: true },
  { id: "linkedin", name: "LinkedIn", description: "Auto-publish posts & articles", kind: "channel", managedAuth: true },
  { id: "youtube", name: "YouTube", description: "Channel analytics & uploads", kind: "channel", managedAuth: true },
  { id: "reddit", name: "Reddit", description: "Post to subreddits on cadence", kind: "channel", managedAuth: true },
  { id: "twitter", name: "X (Twitter)", description: "Schedule threads & tweets", kind: "channel", managedAuth: false },
  { id: "tiktok", name: "TikTok", description: "Publish short-form video", kind: "channel", managedAuth: false },
  { id: "slack", name: "Slack", description: "Growth alerts in your channels", kind: "tool", managedAuth: true },
];

/**
 * Display name for a toolkit slug, including the ones the goal layer targets.
 * Keyed by the NORMALIZED slug, so look up through `normalizeSlug` — the goal
 * layer says "x" where Composio says "twitter".
 */
export const CHANNEL_NAME: Record<string, string> = Object.fromEntries(
  PLATFORMS.map((p) => [p.id, p.name]),
);

/** Composio toolkit slugs are lowercase identifiers — validate at boundaries. */
export const SLUG_RE = /^[a-z0-9_-]{1,64}$/;

const BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

/** Legacy aliases (old UI/DB rows used "x") -> toolkit slugs. */
const ALIASES: Record<string, Platform> = { x: "twitter" };

export function normalizeSlug(id: string): string {
  return ALIASES[id] ?? id;
}

export function platformMeta(id: string): PlatformMeta | undefined {
  return BY_ID.get(normalizeSlug(id) as Platform);
}

/** Resolve a Slack post destination. Slack's chat API accepts a member id to open a DM. */
export function slackTarget(options?: {
  channel?: string;
  dmUser?: string;
  dm_user?: string;
}): string {
  return (
    options?.dmUser?.trim() ||
    options?.dm_user?.trim() ||
    options?.channel?.trim() ||
    "#general"
  );
}

/**
 * Composio's logo CDN, keyed by toolkit slug — normalized first, because the
 * logo host only knows Composio's own names: a `social_post` step saved as "x"
 * asked for a logo that doesn't exist and fell back to a generic glyph.
 */
export function toolkitLogo(slug: string): string {
  return `https://logos.composio.dev/api/${normalizeSlug(slug)}`;
}

/**
 * Catalog categories exposed in the UI. Ids verified against the v3 filter
 * (most of Composio's 798 raw category ids match nothing — these do).
 */
export const CATALOG_CATEGORIES = [
  { id: "all", name: "All" },
  { id: "crm", name: "CRM" },
  { id: "marketing", name: "Marketing" },
  { id: "communication", name: "Communication" },
  { id: "email", name: "Email" },
  { id: "productivity", name: "Productivity" },
  { id: "project-management", name: "Project management" },
  { id: "analytics", name: "Analytics" },
  { id: "documents", name: "Documents" },
  { id: "ecommerce", name: "E-commerce" },
  { id: "customer-support", name: "Customer support" },
  { id: "scheduling-&-booking", name: "Scheduling" },
  { id: "calendar", name: "Calendar" },
  { id: "developer-tools", name: "Developer tools" },
] as const;
