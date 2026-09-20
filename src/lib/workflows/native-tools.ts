import type { ExecuteResponse } from "@/lib/social/composio";
import {
  businessProfileConfigured,
  listReviews,
  replyToReview,
  type BusinessReview,
} from "@/lib/google/business-profile";
import { runGa4Report } from "@/lib/google/analytics";
import {
  listVikunjaProjects,
  vikunjaClientFor,
} from "@/lib/integrations/vikunja-connection";

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
const NATIVE_APPS = new Set(["googlebusinessprofile", "vikunja"]);

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
  if (app === "vikunja") return true;
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
    case "VIKUNJA_LIST_PROJECTS": {
      try {
        const projects = await listVikunjaProjects(workspaceId);
        return {
          successful: true,
          data: {
            projects: projects.map(({ id, title }) => ({ id, title })),
            text: projects.length
              ? projects.map((project) => `${project.id}: ${project.title}`).join("\n")
              : "No writable Vikunja projects are available.",
          },
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Could not list Vikunja projects.");
      }
    }

    case "VIKUNJA_CREATE_TASK": {
      const projectId = Number(args.project_id ?? args.projectId);
      const title = String(args.title ?? "").trim();
      const description = String(args.description ?? "").trim();
      if (!Number.isSafeInteger(projectId) || projectId <= 0) return failure("project_id is required to create a Vikunja task.");
      if (!title) return failure("title is required to create a Vikunja task.");
      try {
        const client = await vikunjaClientFor(workspaceId);
        const task = await client.createTask(projectId, { title, description });
        return {
          successful: true,
          data: {
            task_id: task.id,
            title: task.title,
            description: task.description ?? description,
            project_id: projectId,
            task_url: client.taskUrl(task.id),
          },
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Could not create the Vikunja task.");
      }
    }

    case "VIKUNJA_CREATE_TASKS": {
      const projectId = Number(args.project_id ?? args.projectId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0) return failure("project_id is required to create Vikunja tasks.");
      if (!Array.isArray(args.items)) return failure("items must be an array of meeting action items.");
      if (args.items.length > 50) return failure("A meeting may create at most 50 Vikunja tasks.");
      const meetingTitle = String(args.meeting_title ?? "").trim();
      const meetingId = String(args.meeting_id ?? "").trim();
      const context = [
        meetingTitle ? `Meeting: ${meetingTitle}` : "",
        meetingId ? `Meeting ID: ${meetingId}` : "",
      ].filter(Boolean).join("\n");
      try {
        const client = await vikunjaClientFor(workspaceId);
        const tasks: Record<string, unknown>[] = [];
        const failed: Record<string, unknown>[] = [];
        for (let index = 0; index < args.items.length; index++) {
          const raw = args.items[index];
          if (!raw || typeof raw !== "object") {
            failed.push({ index, error: "Action item must be an object." });
            continue;
          }
          const item = raw as { title?: unknown; description?: unknown };
          const title = typeof item.title === "string" ? item.title.trim() : "";
          if (!title) {
            failed.push({ index, error: "Action item is missing a title." });
            continue;
          }
          const itemDescription = typeof item.description === "string" ? item.description.trim() : "";
          const description = [itemDescription, context].filter(Boolean).join("\n\n");
          try {
            const task = await client.createTask(projectId, { title, description });
            tasks.push({ index, task_id: task.id, title: task.title, task_url: client.taskUrl(task.id) });
          } catch (error) {
            failed.push({ index, title, error: error instanceof Error ? error.message : "Task creation failed." });
          }
        }
        return {
          successful: true,
          data: {
            tasks,
            failed,
            created_count: tasks.length,
            failed_count: failed.length,
            text: `${tasks.length} Vikunja task(s) created${failed.length ? `; ${failed.length} item(s) failed` : ""}.`,
          },
        };
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Could not create Vikunja tasks.");
      }
    }

    case "VIKUNJA_GET_TASK": {
      const taskId = Number(args.task_id ?? args.taskId);
      if (!Number.isSafeInteger(taskId) || taskId <= 0) return failure("task_id is required to read a Vikunja task.");
      try {
        const client = await vikunjaClientFor(workspaceId);
        const task = await client.getTask(taskId);
        return { successful: true, data: { ...task, task_url: client.taskUrl(task.id) } };
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Could not read the Vikunja task.");
      }
    }

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

    case "GOOGLE_ANALYTICS_RUN_REPORT": {
      try {
        return { successful: true, data: await runGa4Report(workspaceId, args) };
      } catch (error) {
        return failure(error instanceof Error ? error.message : "Could not run the GA4 report.");
      }
    }

    default:
      return null;
  }
}
