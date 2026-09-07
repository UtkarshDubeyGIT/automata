import type { ExecuteResponse } from "@/lib/social/composio";
import {
  businessProfileConfigured,
  listReviews,
  replyToReview,
  type BusinessReview,
} from "@/lib/google/business-profile";

/**
 * Tools we implement ourselves instead of calling Composio for.
 *
 * There is exactly one app here and it is here for a hard reason: Composio has
 * no Google Business Profile toolkit at all (verified live — every plausible
 * slug 404s), so review replies cannot be routed through the normal path no
 * matter how the registry is written.
 *
 * The shim exists so that fact stops leaking. `steps.ts` runs `app_action`
 * steps and `sweep.ts` polls triggers; both used to branch on
 * `SIMULATED_APPS.has(spec.app)` and produce a fabrication. Now both ask here
 * first, and get back the SAME `ExecuteResponse` shape Composio returns — so
 * the engine's idempotency, billing, journalling and error handling are
 * untouched, and a Business Profile step is ordinary everywhere downstream.
 *
 * When the deployment has no Google client configured this reports
 * `supported: false` and the caller falls back to simulation exactly as
 * before, so a demo install keeps working end to end.
 */

/** Apps whose tools run through this module rather than Composio. */
const NATIVE_APPS = new Set(["googlebusinessprofile"]);

/**
 * Can this app run for real here and now?
 *
 * Deliberately takes the CONFIGURED state into account, not just the app:
 * "we implement this" and "this deployment can actually do it" are different
 * questions, and answering the first when the caller asked the second is how
 * an unconfigured install ends up throwing instead of demoing.
 */
export function runsNatively(app: string): boolean {
  if (!NATIVE_APPS.has(app)) return false;
  if (app === "googlebusinessprofile") return businessProfileConfigured;
  return false;
}

/**
 * Reviews, in the shape the `NEW_GOOGLE_REVIEW` trigger declares and the
 * sweep's cursor logic expects.
 *
 * `review_id` is not incidental: `recordId` in sweep.ts looks for exactly that
 * key to track which reviews have already fired. Renaming it would make every
 * poll look like a page of brand-new reviews and fire a run per review, per
 * poll, forever.
 *
 * Newest first, because `untilCursor` slices from the front assuming that
 * order — Google's `orderBy=updateTime desc` already matches.
 */
function toRecords(reviews: BusinessReview[]): Record<string, unknown>[] {
  return reviews.map((r) => ({
    review_id: r.reviewId,
    reviewer: r.reviewer,
    rating: r.rating,
    text: r.comment,
    created_at: r.createdAt,
    // Present so a workflow can skip what the owner already answered. Without
    // it, an automation that replies to every review re-answers the whole back
    // catalogue the first time it runs against an established business.
    existing_reply: r.reply,
  }));
}

function failure(error: string): ExecuteResponse {
  return { successful: false, error, data: {} };
}

/**
 * Execute one native tool. Returns null when this module does not own the
 * slug, so the caller can fall through to its Composio path.
 */
export async function executeNativeTool(
  slug: string,
  workspaceId: string,
  args: Record<string, unknown>,
): Promise<ExecuteResponse | null> {
  switch (slug) {
    case "GOOGLEBUSINESS_GET_REVIEWS": {
      const limit = Number(args.limit ?? args.page_size ?? 20);
      const res = await listReviews(workspaceId, Number.isFinite(limit) ? limit : 20);
      if ("error" in res) return failure(res.error);
      const reviews = toRecords(res.reviews);
      return {
        successful: true,
        data: {
          reviews,
          // A read step's output is summarised for the user and fed to any AI
          // step downstream, so it says what it is rather than dumping JSON.
          text: reviews.length
            ? `${reviews.length} review(s):\n` +
              reviews
                .map((r) => `- ${r.reviewer} (${r.rating ?? "?"}★): ${String(r.text ?? "").slice(0, 160)}`)
                .join("\n")
            : "No reviews found for this business yet.",
        },
      };
    }

    case "GOOGLEBUSINESS_REPLY_TO_REVIEW": {
      const reviewId = String(args.review_id ?? args.reviewId ?? "").trim();
      const comment = String(args.comment ?? args.reply ?? args.text ?? "").trim();
      if (!reviewId) return failure("review_id is required to reply to a review.");
      const res = await replyToReview(workspaceId, reviewId, comment);
      if ("error" in res) return failure(res.error);
      return { successful: true, data: { review_id: reviewId, replied: true } };
    }

    default:
      return null;
  }
}
