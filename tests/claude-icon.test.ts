import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { NODE_TYPES } from "@/lib/workflows/blocks";

test("AI workflow modules use the Claude brand icon", () => {
  assert.equal(NODE_TYPES.ai_step.icon, "claude");
  const iconSource = fs.readFileSync(path.join(import.meta.dirname, "../src/components/ui/icon.tsx"), "utf8");
  assert.match(iconSource, /claude:\s*ClaudeIcon/);
});
