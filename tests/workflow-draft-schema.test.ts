import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const directory = join(process.cwd(), "supabase", "migrations");
const schema = readdirSync(directory).filter((file) => file.endsWith(".sql")).map((file) => readFileSync(join(directory, file), "utf8")).join("\n");

test("workflow drafts are separate from the published runtime config", () => {
  assert.match(schema, /draft_config jsonb/i);
  assert.match(schema, /draft_positions jsonb/i);
  assert.match(schema, /draft_revision bigint/i);
});
