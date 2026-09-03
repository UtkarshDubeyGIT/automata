import type { SupabaseClient } from "@supabase/supabase-js";
import { socialProvider, normalizeSlug, CHANNEL_NAME, type PostInput } from "./composio";
import { publishLinkedInCarousel } from "./carousel-publish";
import type { CarouselSlide } from "@/lib/ai/content";
import { captionWithWebsiteLink, normalizeStoredPostExtras } from "./post-media";

/**
 * The publisher — the step that was missing.
 *
 * `scheduler.queue` has always written a row into `scheduled_posts` and stopped
 * there. Nothing read those rows back, so a queued post was a database record
 * and never a post: the agent could plan, write and schedule an entire campaign
 * and not one word of it ever reached an audience. This module is what turns a
 * due row into a real publish through Composio.
 *
 * Two properties matter more than anything else here, because this is the one
 * place in the product that takes an irreversible, outward-facing action:
 *
 *  - EXACTLY ONCE. A row is claimed with a compare-and-swap before any provider
 *    call. Two overlapping workers (a cron beat and a user pressing Publish)
 *    cannot both send the same post, because only one of them wins the claim.
 *  - NEVER WITHOUT PERMISSION. Publishing requires a connected account for the
 *    channel; anything else is left queued and reported, not silently dropped.
 */

type Db = SupabaseClient;

/** Guardrail default when `agent_settings.guardrails.posts` is on. */
export const DAILY_POST_CAP = 8;

/**
 * A claim older than this is assumed dead and returned to the queue. Long
 * enough that a genuinely slow provider call is never stolen mid-flight
 * (the route's own ceiling is 300s), short enough that a redeploy does not
 * cost the user a day.
 */
const CLAIM_TTL_MS = 15 * 60 * 1000;

/**
 * How many times a post is retried before it is parked as `failed`.
 *
 * Resetting a failure straight back to `scheduled` — as this did — means a
 * permanently broken channel (a revoked token) is retried on every sweep
 * forever, and the Scheduler's "Failed" tile stays at zero because nothing
 * ever writes that status. Giving up eventually is what makes the number on
 * that tile true.
 */
const MAX_ATTEMPTS = 5;

/**
 * Whether migration 0011 has been applied.
 *
 * The cap, the stale-claim reclaim and the retry ceiling all need columns that
 * 0011 adds. Depending on them unconditionally would mean this module silently
 * publishes NOTHING on a database that hasn't been migrated yet — a worse
 * failure than the bugs they fix, and one nobody would notice until a campaign
 * quietly never went out. So it is probed once and the safeguards degrade to
 * the legacy behaviour until the migration lands, at which point they switch
 * on by themselves with no redeploy.
 */
let trackingColumns: boolean | null = null;
let postExtraColumns: boolean | null = null;

async function hasTracking(db: Db): Promise<boolean> {
  if (trackingColumns !== null) return trackingColumns;
  const { error } = await db.from("scheduled_posts").select("published_at").limit(1);
  trackingColumns = !error;
  if (!trackingColumns) {
    console.warn(
      "[publish] supabase/migrations/0011_publish_tracking.sql is not applied — " +
        "daily cap is counted by scheduled_at, stale claims are not reclaimed, " +
        "and failed sends retry without a ceiling. Apply it to enable these.",
    );
  }
  return trackingColumns;
}

async function hasPostExtras(db: Db): Promise<boolean> {
  if (postExtraColumns !== null) return postExtraColumns;
  const { error } = await db.from("scheduled_posts").select("media, link, options").limit(1);
  postExtraColumns = !error;
  if (!postExtraColumns) {
    console.warn(
      "[publish] add_scheduled_post_media migration is not applied — queued posts " +
        "will publish as text-only until media/link/options columns exist.",
    );
  }
  return postExtraColumns;
}

export interface PublishOutcome {
  id: string;
  platform: string;
  ok: boolean;
  externalId?: string;
  error?: string;
}

export interface PublishSummary {
  published: number;
  failed: number;
  skipped: number;
  results: PublishOutcome[];
  /** Channels a due post needed but the workspace has not authorized. */
  missingChannels: string[];
  reason?: string;
}

interface DuePost {
  id: string;
  platform: string;
  body: string;
  content_id: string | null;
  scheduled_at: string;
  attempts: number | null;
  media?: unknown;
  link?: unknown;
  options?: unknown;
}

interface QueuedCarousel {
  slides: CarouselSlide[];
  title: string;
  brand: { company: string | null };
}

/**
 * Slides for whichever due posts are carousels.
 *
 * `scheduled_posts` stores only the flattened text, so the structure has to be
 * read back off the content item it was queued from. Loaded in one query for
 * the whole sweep — a per-post lookup would be a round trip each to discover
 * that most of them are ordinary posts.
 *
 * A carousel whose slides are missing is deliberately NOT treated as an error:
 * it falls through to the normal text path and still publishes. Losing the
 * swipe cards is worse than a plain post, but not as bad as not posting.
 */
async function loadCarousels(
  db: Db,
  contentIds: string[],
  company: string | null,
): Promise<Map<string, QueuedCarousel>> {
  const map = new Map<string, QueuedCarousel>();
  if (!contentIds.length) return map;

  const { data } = await db
    .from("content_items")
    .select("id, format, topic, meta")
    .in("id", contentIds);

  for (const row of (data ?? []) as {
    id: string;
    format: string | null;
    topic: string | null;
    meta: Record<string, unknown> | null;
  }[]) {
    if (row.format !== "carousel") continue;
    const slides = row.meta?.slides;
    if (!Array.isArray(slides) || !slides.length) continue;
    map.set(row.id, {
      slides: slides as CarouselSlide[],
      title: row.topic ?? "Carousel",
      brand: { company },
    });
  }
  return map;
}

/**
 * Publish everything due for one workspace.
 *
 * `postIds` narrows it to specific rows — that is the user pressing Publish on
 * one queued item, which may go out ahead of its window. Without it the sweep
 * takes only what is genuinely due, which is what the unattended worker wants.
 */
export async function publishDuePosts(
  db: Db,
  workspaceId: string,
  opts: { postIds?: string[]; cap?: number; now?: Date } = {},
): Promise<PublishSummary> {
  const empty: PublishSummary = {
    published: 0,
    failed: 0,
    skipped: 0,
    results: [],
    missingChannels: [],
  };
  const now = opts.now ?? new Date();

  const tracked = await hasTracking(db);
  const hasExtras = await hasPostExtras(db);

  // Anything claimed but never resolved goes back in the queue first, so an
  // interrupted run costs a delay rather than the post.
  if (tracked) await reclaimStaleClaims(db, workspaceId, now);

  let query = db
    .from("scheduled_posts")
    .select(
      `${
        tracked
          ? "id, platform, body, content_id, scheduled_at, attempts"
          : "id, platform, body, content_id, scheduled_at"
      }${hasExtras ? ", media, link, options" : ""}`,
    )
    .eq("workspace_id", workspaceId)
    .eq("status", "scheduled")
    .order("scheduled_at", { ascending: true });

  if (opts.postIds?.length) {
    query = query.in("id", opts.postIds);
  } else {
    query = query.lte("scheduled_at", now.toISOString());
  }

  const { data } = await query.limit(50);
  // Cast through unknown: the column list is chosen at runtime (see
  // hasTracking), which defeats supabase-js's literal-based row typing.
  const due = (data ?? []) as unknown as DuePost[];
  if (!due.length) return empty;

  // The daily cap counts what this workspace has ALREADY sent today, so a burst
  // of due posts can't blow through it by arriving in one sweep.
  const cap = opts.cap ?? DAILY_POST_CAP;
  const sentToday = await publishedToday(db, workspaceId, now, tracked);
  let remaining = Math.max(0, cap - sentToday);

  // One live lookup, not one per post.
  const connected = await connectedChannels(workspaceId);

  // Slides for any carousels in this batch, plus the brand name they are
  // rendered under. Both are one query for the whole sweep.
  const { data: wsRow } = await db
    .from("workspaces")
    .select("brand_profile")
    .eq("id", workspaceId)
    .maybeSingle();
  const company =
    ((wsRow as { brand_profile?: { company?: string } } | null)?.brand_profile?.company) ?? null;
  const carousels = await loadCarousels(
    db,
    due.map((p) => p.content_id).filter((id): id is string => !!id),
    company,
  );

  const results: PublishOutcome[] = [];
  const missing = new Set<string>();
  let published = 0;
  let failed = 0;
  let skipped = 0;

  for (const post of due) {
    const slug = normalizeSlug(post.platform);

    if (!connected.has(slug)) {
      // Leave it queued. The moment the account is connected the next sweep
      // picks it up — losing the post here would be the worse failure.
      missing.add(slug);
      skipped++;
      continue;
    }

    if (remaining <= 0) {
      skipped++;
      continue;
    }

    // Claim before sending. `.eq("status", "scheduled")` makes this a
    // compare-and-swap: whoever flips the row first owns the send.
    const { data: claimed } = await db
      .from("scheduled_posts")
      // published_at doubles as the claim stamp — without it a claim that
      // never resolves is indistinguishable from one still in flight.
      .update(
        tracked
          ? { status: "publishing", published_at: now.toISOString() }
          : { status: "publishing" },
      )
      .eq("id", post.id)
      .eq("status", "scheduled")
      .select("id")
      .maybeSingle();
    if (!claimed) {
      skipped++;
      continue;
    }

    // A carousel only stays a carousel on LinkedIn, and only via the document
    // API. Anywhere else the flattened text is the post, which is what every
    // other channel would have published anyway.
    const carousel = post.content_id ? carousels.get(post.content_id) : undefined;
    const extras = normalizeStoredPostExtras(post);

    // `socialProvider.live` gates it too, so an unconfigured install still
    // simulates the send rather than failing on a missing credential.
    const result =
      carousel && slug === "linkedin" && socialProvider.live && !extras.media
        ? await publishLinkedInCarousel({
            entityId: workspaceId,
            slides: carousel.slides,
            text: captionWithWebsiteLink(post.body, extras.link),
            title: carousel.title,
            brand: carousel.brand,
            pageId: extras.options?.pageId,
          })
        : await socialProvider.post({
            entityId: workspaceId,
            platform: slug,
            text: post.body,
            mediaUrl: extras.media?.url,
            media: extras.media,
            link: extras.link,
            options: extras.options as PostInput["options"],
          });

    if (result.ok) {
      await db
        .from("scheduled_posts")
        .update({
          status: "published",
          external_id: result.externalId ?? null,
          // The cap counts by this, not by scheduled_at: a backlog published
          // today is eight posts today, whatever day they were meant for.
          ...(tracked ? { published_at: new Date().toISOString(), last_error: null } : {}),
        })
        .eq("id", post.id);
      if (post.content_id) {
        await db.from("content_items").update({ status: "published" }).eq("id", post.content_id);
      }
      published++;
      remaining--;
      results.push({ id: post.id, platform: slug, ok: true, externalId: result.externalId });
    } else {
      // Most publish errors are transient (a rate limit, a token the user can
      // refresh), so the row goes back in the queue — but only for so long.
      // Retrying forever is what let a revoked token re-attempt the same posts
      // on every beat while the Scheduler reported nothing wrong.
      const attempts = (post.attempts ?? 0) + 1;
      const giveUp = tracked && attempts >= MAX_ATTEMPTS;
      await db
        .from("scheduled_posts")
        .update({
          status: giveUp ? "failed" : "scheduled",
          external_id: null,
          ...(tracked
            ? { published_at: null, attempts, last_error: result.error ?? "Publish failed" }
            : {}),
        })
        .eq("id", post.id);
      failed++;
      results.push({ id: post.id, platform: slug, ok: false, error: result.error });
    }
  }

  return {
    published,
    failed,
    skipped,
    results,
    missingChannels: [...missing],
    reason:
      published === 0 && missing.size
        ? `Waiting on ${[...missing].map((s) => CHANNEL_NAME[s] ?? s).join(", ")}.`
        : undefined,
  };
}

/** Toolkit slugs this workspace has a live Composio account for. */
async function connectedChannels(workspaceId: string): Promise<Set<string>> {
  if (!socialProvider.live) return new Set();
  try {
    const conns = await socialProvider.listConnections(workspaceId);
    return new Set(conns.filter((c) => c.status === "connected").map((c) => c.platform));
  } catch {
    // Composio unreachable — publish nothing rather than guess. The posts stay
    // queued and the next sweep tries again.
    return new Set();
  }
}

/**
 * How many posts this workspace has actually SENT today.
 *
 * Counting by `scheduled_at` — when a post was meant to go out — meant a
 * backlog defeated the cap entirely: every row stamped last Saturday counted
 * as zero today, so the ceiling reset to full on every hourly sweep.
 * `published_at` is when it really went, which is the only thing a
 * posts-per-day guardrail can honestly be measured against.
 */
async function publishedToday(
  db: Db,
  workspaceId: string,
  now: Date,
  tracked: boolean,
): Promise<number> {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const { count } = await db
    .from("scheduled_posts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .eq("status", "published")
    .gte(tracked ? "published_at" : "scheduled_at", midnight.toISOString());
  return count ?? 0;
}

/** Return abandoned claims to the queue so they can be retried. */
async function reclaimStaleClaims(db: Db, workspaceId: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - CLAIM_TTL_MS).toISOString();
  await db
    .from("scheduled_posts")
    .update({ status: "scheduled", published_at: null })
    .eq("workspace_id", workspaceId)
    .eq("status", "publishing")
    .lt("published_at", cutoff);
}
