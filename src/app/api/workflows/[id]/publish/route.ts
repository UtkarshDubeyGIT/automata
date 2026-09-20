import { NextResponse, type NextRequest } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { brandKnowsProduct, getBrandProfileForWorkspace } from "@/lib/brand";
import { connectionsOf, needsBrandGrounding, requiredAppsOf, unconnected } from "@/lib/workflows/apps";
import { socialProvider } from "@/lib/social/composio";
import { deriveDisplay, scheduleText } from "@/lib/workflows/display";
import { draftIssues } from "@/lib/workflows/editor";
import { repairRefs } from "@/lib/workflows/repair";
import { setupGaps, validateGraph } from "@/lib/workflows/validate";
import type { WorkflowConfig } from "@/lib/workflows/types";
import { firecrawlConfigured } from "@/lib/env";
import { setupNotice } from "@/lib/setup-notice";
import { serverOwnedRows } from "@/lib/integrations/server-owned-rows";
import { readCachedIntegrations } from "@/lib/social/integrations-store";

const FIRECRAWL_UNAVAILABLE = setupNotice(
  "Web research isn't available yet, so this automation can't be saved. Please try again later.",
  "FIRECRAWL_API_KEY is not set, so web research steps cannot run.",
);

export async function POST(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to save automations" }, { status: 401 });
  }

  const { data: row, error } = await rc.supabase
    .from("workflows")
    .select("id, config, draft_config, draft_revision")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 502 });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidate = (row.draft_config as WorkflowConfig | null)?.graph;
  if (!candidate) return NextResponse.json({ error: "This draft has no graph" }, { status: 400 });
  const { graph } = repairRefs(candidate);
  try {
    validateGraph(graph);
  } catch (cause) {
    return NextResponse.json({ error: cause instanceof Error ? cause.message : "This draft cannot be saved" }, { status: 400 });
  }
  const issues = draftIssues(graph);
  if (issues.length) return NextResponse.json({ error: issues[0].message, issues }, { status: 400 });
  const gaps = setupGaps(graph);
  if (Object.values(gaps).some((items) => items.length)) {
    return NextResponse.json({ error: "Finish the required module fields before saving", gaps }, { status: 400 });
  }

  // Web research has no per-workspace connection: it is on when the server
  // holds a Firecrawl key and off otherwise.
  if (requiredAppsOf(graph).some((item) => item.app === "firecrawl") && !firecrawlConfigured) {
    return NextResponse.json({ error: FIRECRAWL_UNAVAILABLE }, { status: 409 });
  }
  if (rc.entityId && socialProvider.live) {
    try {
      const connected = await socialProvider.listConnections(rc.entityId);
      // Apps we host ourselves are absent from every Composio listing; their
      // rows come from our own server, exactly as the status endpoint says.
      const own = await serverOwnedRows(rc, await readCachedIntegrations(rc));
      const missing = unconnected(connectionsOf(requiredAppsOf(graph), [...connected, ...own], true));
      if (missing.length) {
        return NextResponse.json({ error: `Connect ${missing.map((item) => item.label).join(" and ")} before saving` }, { status: 409 });
      }
    } catch {
      // Composio availability must not turn a valid draft into data loss.
    }
  }
  if (needsBrandGrounding(graph)) {
    try {
      if (!brandKnowsProduct(await getBrandProfileForWorkspace(rc.workspaceId))) {
        return NextResponse.json({ error: "Complete the Brand voice profile before saving AI-generated output" }, { status: 409 });
      }
    } catch {
      // Existing activation checks still protect unattended execution.
    }
  }

  const config: WorkflowConfig = {
    ...(row.draft_config as WorkflowConfig),
    v: 1,
    graph,
    display: { groups: deriveDisplay(graph) },
  };
  const { data: saved, error: saveError } = await rc.supabase
    .from("workflows")
    .update({ config, draft_config: config, schedule: scheduleText(config) })
    .eq("id", id)
    .eq("draft_revision", row.draft_revision)
    .select("id")
    .maybeSingle();
  if (saveError) return NextResponse.json({ error: saveError.message }, { status: 502 });
  if (!saved) return NextResponse.json({ error: "revision_conflict", code: "revision_conflict" }, { status: 409 });
  return NextResponse.json({ ok: true, graph, revision: row.draft_revision });
}
