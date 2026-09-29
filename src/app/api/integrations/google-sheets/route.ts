import { NextResponse } from "next/server";
import {
  googleSpreadsheets,
  googleSpreadsheetTabs,
  type GoogleSheetTab,
  type GoogleSpreadsheet,
} from "@/lib/social/composio";
import { resolveRequestContext } from "@/lib/workspace";
import { connectedAccountIds } from "@/lib/social/composio-proxy";
import { composioConfigured } from "@/lib/env";

const TTL_MS = 60_000;
const spreadsheetCache = new Map<string, { at: number; items: GoogleSpreadsheet[] }>();
const sheetCache = new Map<string, { at: number; items: GoogleSheetTab[] }>();

function fresh<T>(entry: { at: number; items: T[] } | undefined): entry is { at: number; items: T[] } {
  return !!entry && Date.now() - entry.at < TTL_MS;
}

/**
 * Provider-backed choices for the workflow editor. With no spreadsheetId this
 * lists files; with one it lists that file's tabs. Both are workspace-scoped.
 */
export async function GET(request: Request) {
  const ctx = await resolveRequestContext();
  if (!ctx.userId || !ctx.workspaceId || ctx.entityId !== ctx.workspaceId) {
    return NextResponse.json({ error: "Sign in to list Google Sheets." }, { status: 401 });
  }
  const accounts = composioConfigured ? await connectedAccountIds(ctx.workspaceId, "googlesheets", fetch, true).catch(() => null) : [];
  if (!accounts) return NextResponse.json({ error: "Could not check Google Sheets connection. Try again." }, { status: 502 });
  if (!accounts.length) {
    return NextResponse.json({ error: "Connect Google Sheets to choose a spreadsheet." }, { status: 409 });
  }
  if (accounts.length > 1) return NextResponse.json({ error: "Multiple Google Sheets accounts are connected. Choose one in Integrations." }, { status: 409 });

  const spreadsheetId = new URL(request.url).searchParams.get("spreadsheetId")?.trim();
  if (spreadsheetId) {
    const key = `${ctx.entityId}:${spreadsheetId}`;
    const hit = sheetCache.get(key);
    if (fresh(hit)) return NextResponse.json({ sheets: hit.items });
    try {
      const sheets = await googleSpreadsheetTabs(ctx.entityId, spreadsheetId, true);
      sheetCache.set(key, { at: Date.now(), items: sheets });
      return NextResponse.json({ sheets });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load sheets." }, { status: 502 });
    }
  }

  const hit = spreadsheetCache.get(ctx.entityId);
  if (fresh(hit)) return NextResponse.json({ spreadsheets: hit.items });
  try {
    const spreadsheets = await googleSpreadsheets(ctx.entityId, true);
    spreadsheetCache.set(ctx.entityId, { at: Date.now(), items: spreadsheets });
    return NextResponse.json({ spreadsheets });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load spreadsheets." }, { status: 502 });
  }
}
