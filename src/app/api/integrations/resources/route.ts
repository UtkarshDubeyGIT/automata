import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import { RESOURCE_KINDS, type ResourceKind } from "@/lib/workflows/resources";
import { listResourcePage, ResourceLookupError, type ResourcePage } from "@/lib/workflows/resource-server";

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; page: ResourcePage }>();

export async function GET(request: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.userId || !ctx.workspaceId || ctx.entityId !== ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to choose an integration resource." }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") ?? "";
  if (!RESOURCE_KINDS.includes(kind as ResourceKind)) {
    return NextResponse.json({ error: "Unknown resource kind." }, { status: 400 });
  }
  const cursor = (params.get("cursor") ?? "").slice(0, 1000);
  const parent = (params.get("parent") ?? "").slice(0, 200);
  if (parent && kind !== "linear_project") {
    return NextResponse.json({ error: "Parent is not supported for this resource." }, { status: 400 });
  }
  const key = JSON.stringify([ctx.workspaceId, kind, cursor, parent]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return NextResponse.json(hit.page);

  try {
    const page = await listResourcePage(ctx.workspaceId, kind as ResourceKind, cursor, parent);
    if (cache.size > 500) cache.clear();
    cache.set(key, { at: Date.now(), page });
    return NextResponse.json(page);
  } catch (error) {
    const status = error instanceof ResourceLookupError ? error.status : 502;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not load choices." },
      { status: status ?? 502 },
    );
  }
}
