import { NextResponse, type NextRequest } from "next/server";
import { listToolsForToolkit, searchDynamicTools } from "@/lib/social/composio";
import { resolveRequestContext } from "@/lib/workspace";

/**
 * Browse or search Composio tool definitions (~1000 toolkits).
 * Authenticated per workspace. Merges live API definitions with curated specs.
 */
export async function GET(req: NextRequest) {
  const rc = await resolveRequestContext();
  if (!rc.supabase || !rc.workspaceId) {
    return NextResponse.json({ error: "Sign in to browse tools" }, { status: 401 });
  }

  const params = req.nextUrl.searchParams;
  const toolkit = params.get("toolkit")?.trim() || "";
  const search = params.get("search")?.trim() || "";
  const limitParam = Number(params.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 100;

  try {
    const tools = toolkit
      ? await listToolsForToolkit(toolkit, { search, limit })
      : await searchDynamicTools(search, { limit });

    return NextResponse.json({ tools });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, tools: [] },
      { status: 502 },
    );
  }
}
