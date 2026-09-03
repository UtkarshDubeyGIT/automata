import { NextResponse } from "next/server";
import {
  googleSpreadsheets,
  googleSpreadsheetTabs,
  type GoogleSheetTab,
  type GoogleSpreadsheet,
} from "@/lib/social/composio";
import { resolveRequestContext } from "@/lib/workspace";

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
  if (!ctx.entityId) {
    return NextResponse.json({ error: "Sign in to list Google Sheets." }, { status: 401 });
  }

  const spreadsheetId = new URL(request.url).searchParams.get("spreadsheetId")?.trim();
  if (spreadsheetId) {
    const key = `${ctx.entityId}:${spreadsheetId}`;
    const hit = sheetCache.get(key);
    if (fresh(hit)) return NextResponse.json({ sheets: hit.items });
    const sheets = await googleSpreadsheetTabs(ctx.entityId, spreadsheetId);
    sheetCache.set(key, { at: Date.now(), items: sheets });
    return NextResponse.json({ sheets });
  }

  const hit = spreadsheetCache.get(ctx.entityId);
  if (fresh(hit)) return NextResponse.json({ spreadsheets: hit.items });
  const spreadsheets = await googleSpreadsheets(ctx.entityId);
  spreadsheetCache.set(ctx.entityId, { at: Date.now(), items: spreadsheets });
  return NextResponse.json({ spreadsheets });
}
