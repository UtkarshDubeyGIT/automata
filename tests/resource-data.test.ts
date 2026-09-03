import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseGoogleSheetTabs,
  parseGoogleSpreadsheets,
} from "@/lib/social/resource-data";

test("Google spreadsheet choices accept Sheets and Drive response shapes", () => {
  assert.deepEqual(
    parseGoogleSpreadsheets({
      files: [
        { id: "sheet-1", name: "Recruit Emails" },
        { spreadsheet_id: "sheet-2", title: "Weekly Growth" },
      ],
    }),
    [
      { id: "sheet-1", name: "Recruit Emails" },
      { id: "sheet-2", name: "Weekly Growth" },
    ],
  );
});

test("Google sheet tabs accept native spreadsheet metadata", () => {
  assert.deepEqual(
    parseGoogleSheetTabs({
      sheets: [
        { properties: { sheetId: 0, title: "Sheet1" } },
        { properties: { sheetId: 42, title: "Recruiters" } },
      ],
    }),
    [
      { id: "0", title: "Sheet1" },
      { id: "42", title: "Recruiters" },
    ],
  );
});

test("resource parsers discard incomplete and duplicate provider rows", () => {
  assert.deepEqual(
    parseGoogleSpreadsheets({ items: [{ id: "one", name: "One" }, { id: "one", name: "Again" }, { name: "No id" }] }),
    [{ id: "one", name: "One" }],
  );
  assert.deepEqual(
    parseGoogleSheetTabs({ tabs: [{ id: "1", name: "Leads" }, { id: "2", name: "Leads" }, null] }),
    [{ id: "1", title: "Leads" }],
  );
});
