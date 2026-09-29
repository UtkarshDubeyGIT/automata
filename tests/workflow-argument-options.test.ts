import assert from "node:assert/strict";
import test from "node:test";
import { argumentOptions, optionalChoiceKeys } from "@/lib/workflows/argument-options";
import type { ToolSpec } from "@/lib/workflows/registry";

const tool: ToolSpec = {
  app: "example", kind: "read", external: false, required: ["format"], desc: "Example", argHint: "{}",
  inputSchema: { properties: {
    format: { type: "string", enum: ["CSV", "JSON"] },
    include_archived: { type: "boolean" },
    limit: { type: "integer" },
  } },
};

test("only finite schema arguments become choices", () => {
  assert.deepEqual(argumentOptions(tool, "format"), [
    { value: "CSV", label: "CSV" }, { value: "JSON", label: "JSON" },
  ]);
  assert.deepEqual(argumentOptions(tool, "include_archived"), [
    { value: true, label: "Yes" }, { value: false, label: "No" },
  ]);
  assert.deepEqual(argumentOptions(tool, "limit"), []);
  assert.deepEqual(optionalChoiceKeys(tool), ["include_archived"]);
});

test("static action boolean hints also become Yes/No choices", () => {
  const hinted = { ...tool, inputSchema: undefined, argHint: '{"is_private":true,"name":"updates"}' };
  assert.deepEqual(argumentOptions(hinted, "is_private"), [
    { value: true, label: "Yes" }, { value: false, label: "No" },
  ]);
  assert.deepEqual(optionalChoiceKeys(hinted), ["is_private"]);
});
