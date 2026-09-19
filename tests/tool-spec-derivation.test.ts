import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isPlaceholder, normalizeComposioTool, TOOLS } from "@/lib/workflows/registry";

/**
 * Deriving a ToolSpec for a tool nobody reviewed is what lets the builder
 * reach past the 17 curated integrations to Composio's ~1,553. `kind` is the
 * dangerous field: it drives `liveWrites` and the approval rules, so calling
 * a write a read means an irreversible action against a real account with
 * nobody asked first.
 *
 * Composio publishes the MCP standard annotations (`readOnlyHint`,
 * `destructiveHint`, `openWorldHint`) as tags. These tests pin the rule that
 * makes relying on them safe: positive evidence promotes a tool to `read`,
 * and the ABSENCE of evidence never does.
 */

function composioTool(overrides: Record<string, unknown> = {}) {
  return {
    slug: "ACME_DO_SOMETHING",
    name: "Do something",
    description: "Does a thing",
    toolkit: { slug: "acme", name: "Acme" },
    input_parameters: { type: "object", required: [], properties: {} },
    ...overrides,
  };
}

test("readOnlyHint is what marks a tool as a read", () => {
  const spec = normalizeComposioTool(composioTool({ tags: ["readOnlyHint"] }))?.spec;
  assert.equal(spec?.kind, "read");
  assert.equal(spec?.external, false, "a read affects nobody and must not demand approval");
});

test("a tool with no annotations is treated as an external write", () => {
  // The direction a mistake is survivable in: an unnecessary approval prompt
  // costs a click, a missed one posts to somebody's live account.
  const spec = normalizeComposioTool(composioTool({ tags: [] }))?.spec;
  assert.equal(spec?.kind, "write");
  assert.equal(spec?.external, true);
});

test("destructive and open-world hints never promote a tool to a read", () => {
  for (const tags of [
    ["destructiveHint"],
    ["openWorldHint"],
    ["idempotentHint"],
    ["updateHint"],
    ["openWorldHint", "destructiveHint"],
  ]) {
    const spec = normalizeComposioTool(composioTool({ tags }))?.spec;
    assert.equal(spec?.kind, "write", `tags ${tags.join("+")} must not read as read-only`);
    assert.equal(spec?.external, true);
  }
});

test("the hint is matched case-insensitively", () => {
  // Composio spells it `readOnlyHint`; a payload shouting it must not silently
  // fall through to `write` and bury a read behind an approval step.
  for (const tag of ["readOnlyHint", "READONLYHINT", "readonlyhint"]) {
    assert.equal(normalizeComposioTool(composioTool({ tags: [tag] }))?.spec.kind, "read");
  }
});

test("a curated entry always wins over anything derived", () => {
  // The curated specs carry autofill, defaults and argument hints a person
  // checked; a live payload must only ever contribute schema/version on top.
  const slug = "SLACK_CREATE_CHANNEL";
  const curated = TOOLS[slug];
  assert.ok(curated, "fixture assumption broke: SLACK_CREATE_CHANNEL is no longer curated");
  assert.equal(curated.kind, "write", "this test needs a curated WRITE to be meaningful");

  const derived = normalizeComposioTool(
    composioTool({
      slug,
      // Deliberately contradicts the curated entry on every field that
      // matters — including claiming read-only, the one direction that would
      // strip an approval step off a real write.
      tags: ["readOnlyHint"],
      description: "WRONG DESCRIPTION",
      toolkit: { slug: "not-slack", name: "Not Slack" },
    }),
  )?.spec;

  assert.equal(derived?.kind, "write", "a live payload must not downgrade a curated write to a read");
  assert.equal(derived?.external, curated.external);
  assert.equal(derived?.app, curated.app);
  assert.equal(derived?.desc, curated.desc);
});

test("a derived argHint is valid JSON and offers no value the guard would reject", () => {
  /*
   * Same invariants tests/registry.test.ts enforces on the hand-written
   * catalog. They matter more here, not less: `isPlaceholder` blanks any
   * argument that looks like a stand-in, so a derived hint containing one
   * teaches the model to write a value that is erased on save — or, worse,
   * one that survives and 404s against a real account.
   */
  const spec = normalizeComposioTool(
    composioTool({
      input_parameters: {
        type: "object",
        required: ["channel", "count"],
        properties: {
          channel: { type: "string", description: "Channel id" },
          count: { type: "integer" },
          flag: { type: "boolean" },
          items: { type: "array" },
          nested: { type: "object" },
        },
      },
    }),
  )?.spec;

  assert.ok(spec);
  const hint = JSON.parse(spec.argHint) as Record<string, unknown>;
  for (const arg of spec.required) {
    assert.ok(arg in hint, `required '${arg}' is missing from the derived argHint`);
  }
  const walk = (v: unknown): string[] =>
    typeof v === "string"
      ? isPlaceholder(v)
        ? [v]
        : []
      : Array.isArray(v)
        ? v.flatMap(walk)
        : v && typeof v === "object"
          ? Object.values(v as Record<string, unknown>).flatMap(walk)
          : [];
  assert.deepEqual(walk(hint), [], "derived argHint offers a stand-in value");
});

test("a tool whose toolkit is missing still gets an app from its slug", () => {
  // The connection pre-check keys off `app`; an empty one reads as "not
  // connected" for every workspace and the step can never be switched on.
  const spec = normalizeComposioTool(
    composioTool({ slug: "NOTION_CREATE_PAGE", toolkit: undefined }),
  )?.spec;
  assert.equal(spec?.app, "notion");
});
