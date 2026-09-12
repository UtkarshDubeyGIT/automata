import { NextResponse } from "next/server";
import { resolveRequestContext } from "@/lib/workspace";
import {
  connectVikunja,
  disconnectVikunja,
  listVikunjaProjects,
  vikunjaStatus,
} from "@/lib/integrations/vikunja-connection";
import { VikunjaError } from "@/lib/integrations/vikunja";

const UNAUTHORIZED = "Sign in to manage integrations.";

async function workspace() {
  const ctx = await resolveRequestContext();
  return ctx.workspaceId;
}

function failure(error: unknown) {
  if (error instanceof VikunjaError) {
    const status = error.kind === "credentials" ? 401 : error.kind === "permission" ? 403 : 502;
    return NextResponse.json({ error: error.message, kind: error.kind }, { status });
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : "Vikunja request failed." }, { status: 502 });
}

export async function GET(req?: Request) {
  const workspaceId = await workspace();
  if (!workspaceId) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  try {
    if (req && new URL(req.url).searchParams.get("projects") === "1") {
      const projects = await listVikunjaProjects(workspaceId);
      return NextResponse.json({
        projects: projects.map(({ id, title }) => ({ id, title })),
      });
    }
    return NextResponse.json(await vikunjaStatus(workspaceId));
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: Request) {
  const workspaceId = await workspace();
  if (!workspaceId) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  const body = await req.json().catch(() => null) as { instanceUrl?: unknown; token?: unknown } | null;
  const instanceUrl = typeof body?.instanceUrl === "string" ? body.instanceUrl.trim() : "";
  const token = typeof body?.token === "string" ? body.token.trim() : "";
  if (!instanceUrl) return NextResponse.json({ error: "Paste your deployed Vikunja app URL." }, { status: 400 });
  if (!token) return NextResponse.json({ error: "Paste a Vikunja API token to connect." }, { status: 400 });
  try {
    return NextResponse.json(await connectVikunja(workspaceId, instanceUrl, token));
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE() {
  const workspaceId = await workspace();
  if (!workspaceId) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  try {
    await disconnectVikunja(workspaceId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
