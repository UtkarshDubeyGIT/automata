/**
 * Provider-resource shapes shared by the server-side Composio adapter and its
 * tests. This file deliberately has no provider client or environment import.
 */

export interface GoogleSpreadsheet {
  id: string;
  name: string;
}

export interface GoogleSheetTab {
  id: string;
  title: string;
}

function arraysInside(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const row = data as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(row[key])) return row[key] as unknown[];
  }
  if (row.data && row.data !== data) return arraysInside(row.data, keys);
  return [];
}

/** Accept the list shapes returned by both Sheets and Drive-backed actions. */
export function parseGoogleSpreadsheets(data: unknown): GoogleSpreadsheet[] {
  const rows = arraysInside(data, ["spreadsheets", "files", "items", "results"]);
  const seen = new Set<string>();
  return rows.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const id = row.spreadsheet_id ?? row.spreadsheetId ?? row.file_id ?? row.fileId ?? row.id;
    const name = row.name ?? row.title ?? row.spreadsheet_name ?? row.spreadsheetName;
    if (id == null || name == null || seen.has(String(id))) return [];
    seen.add(String(id));
    return [{ id: String(id), name: String(name) }];
  });
}

/** Accept the native `{sheets:[{properties:{...}}]}` response and flat forms. */
export function parseGoogleSheetTabs(data: unknown): GoogleSheetTab[] {
  const rows = arraysInside(data, ["sheets", "tabs", "items"]);
  const seen = new Set<string>();
  return rows.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const row = raw as Record<string, unknown>;
    const props =
      row.properties && typeof row.properties === "object"
        ? (row.properties as Record<string, unknown>)
        : row;
    const title = props.title ?? props.name ?? row.title ?? row.name;
    const id = props.sheetId ?? props.sheet_id ?? props.id ?? row.sheetId ?? row.id ?? index;
    if (title == null || seen.has(String(title))) return [];
    seen.add(String(title));
    return [{ id: String(id), title: String(title) }];
  });
}
