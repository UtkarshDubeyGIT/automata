import { strict as assert } from "node:assert";
import { test } from "node:test";
import { interpolate, resolveDeep, assertResolved } from "@/lib/workflows/interpolate";
import type { RunContext } from "@/lib/workflows/types";

/**
 * `interpolate` always renders a STRING (an object embedded in prose becomes
 * its JSON text). `resolveDeep` resolves a step's `arguments` object and must
 * preserve real types for a bare `{{...}}` reference — this is the case the
 * Notetaker → Vikunja template depends on: `items: "{{steps.extract.actionItems}}"`
 * must hand VIKUNJA_CREATE_TASKS an actual array, not that array's JSON text.
 */

const ctx = (data: RunContext) => ({ data, reads: new Set<string>() });

test("interpolate embeds an object as JSON text inside a larger string", () => {
  const data: RunContext = { steps: { extract: { actionItems: [{ title: "A" }] } }, input: {} };
  const out = interpolate("Items: {{steps.extract.actionItems}}", data);
  assert.equal(out, 'Items: [{"title":"A"}]');
});

test("interpolate renders a scalar as plain text", () => {
  const data: RunContext = { steps: {}, input: { title: "Product sync" } };
  assert.equal(interpolate("Meeting: {{trigger.title}}", data), "Meeting: Product sync");
});

test("interpolate leaves an unresolved reference literal", () => {
  const data: RunContext = { steps: {}, input: {} };
  const out = interpolate("{{steps.missing.text}}", data);
  assert.equal(out, "{{steps.missing.text}}");
});

test("interpolate records which upstream step id was actually read", () => {
  const data: RunContext = { steps: { extract: { actionItems: [] } }, input: {} };
  const reads = new Set<string>();
  interpolate("{{steps.extract.actionItems}}", data, reads);
  assert.deepEqual([...reads], ["extract"]);
});

test("resolveDeep preserves an array for a bare reference — the Notetaker/Vikunja regression", () => {
  const items = [
    { title: "Send proposal", description: "Owner mentioned: Alex" },
    { title: "Book follow-up", description: "" },
  ];
  const data: RunContext = { steps: { extract_actions: { actionItems: items } }, input: {} };
  const args = resolveDeep(
    { project_id: 21, items: "{{steps.extract_actions.actionItems}}" },
    ctx(data),
  ) as { project_id: number; items: unknown };

  assert.ok(Array.isArray(args.items), "items must be an array, not its JSON string");
  assert.deepEqual(args.items, items);
});

test("resolveDeep preserves a nested object for a bare reference", () => {
  const data: RunContext = { steps: { fetch: { result: { id: 7, nested: { ok: true } } } }, input: {} };
  const args = resolveDeep({ payload: "{{steps.fetch.result}}" }, ctx(data)) as { payload: unknown };
  assert.deepEqual(args.payload, { id: 7, nested: { ok: true } });
});

test("resolveDeep still stringifies an object reference embedded in a larger string", () => {
  const data: RunContext = { steps: { extract: { actionItems: [{ title: "A" }] } }, input: {} };
  const args = resolveDeep(
    { note: "Items: {{steps.extract.actionItems}}" },
    ctx(data),
  ) as { note: string };
  assert.equal(args.note, 'Items: [{"title":"A"}]');
});

test("resolveDeep leaves a bare reference to a missing path as the literal template", () => {
  const data: RunContext = { steps: {}, input: {} };
  const args = resolveDeep({ items: "{{steps.missing.actionItems}}" }, ctx(data)) as { items: unknown };
  assert.equal(args.items, "{{steps.missing.actionItems}}");
  assert.throws(() => assertResolved(args.items, "items"), /unresolved reference/);
});

test("resolveDeep preserves a scalar reference's real type (not just strings)", () => {
  const data: RunContext = { steps: { count: { result: { n: 3 } } }, input: {} };
  const args = resolveDeep({ n: "{{steps.count.result.n}}" }, ctx(data)) as { n: unknown };
  assert.equal(args.n, 3);
  assert.equal(typeof args.n, "number");
});

test("resolveDeep recurses through nested arrays and objects, resolving each leaf", () => {
  const data: RunContext = { steps: { extract: { actionItems: [{ title: "A" }] } }, input: { meeting_id: "m-1" } };
  const args = resolveDeep(
    { items: "{{steps.extract.actionItems}}", meta: { meeting_id: "{{trigger.meeting_id}}" } },
    ctx(data),
  ) as { items: unknown; meta: { meeting_id: string } };
  assert.deepEqual(args.items, [{ title: "A" }]);
  assert.equal(args.meta.meeting_id, "m-1");
});
