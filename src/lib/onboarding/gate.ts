import type { WorkspaceContext } from "@/lib/workspace";

/**
 * Whether this request should be diverted into the first-run flow.
 *
 * Kept free of Next and Supabase imports so the decision can be tested on its
 * own — the redirect that consumes it lives in a server layout, which is far
 * more awkward to exercise.
 *
 * Demo mode is excluded deliberately: an unconfigured or briefly unreachable
 * Supabase resolves to the DEMO context, which reports `onboarded: true`. That
 * makes the gate fail open. Trapping a signed-in user in onboarding because a
 * query blipped is a worse outcome than letting someone skip it.
 */
export function shouldOnboard(ctx: WorkspaceContext): boolean {
  if (ctx.demo) return false;
  if (!ctx.workspaceId) return false;
  return !ctx.onboarded;
}
