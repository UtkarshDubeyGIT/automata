import type { RunContext } from "./types";

/**
 * The pure half of the step library: template resolution and response shaping.
 *
 * These were the tail of `steps.ts`, which is a problem of dependencies rather
 * than of length. `steps.ts` statically imports the OpenAI client, the Composio
 * client, the image generator, the credit ledger and the Supabase admin client,
 * because its handlers genuinely need them — so ANY module that wanted one of
 * these six functions inherited all of that. `preview.ts` wanted exactly one
 * (`interpolate`) and paid the whole bill; `src/lib/workflows/AGENTS.md` records
 * the same shape under `apps.ts` as the trap that "breaks the production build
 * while `tsc --noEmit` stays green", because a client component importing such
 * a module type-checks fine and fails at bundle time.
 *
 * Nothing here touches the network, the database or a provider. It is a pure
 * function of its arguments, which is also what makes it directly testable
 * without the module mocks every handler test needs.
 *
 * `steps.ts` re-exports all six, so existing importers are unaffected — this is
 * a move, not a rename.
 */

/** What `resolveDeep` needs of a step context: the data, and where to record
 *  what it read. Structural, so a full `StepCtx` satisfies it without this
 *  module having to know the handler-side type (and its provider imports). */
export interface ResolveScope {
  data: RunContext;
  reads?: Set<string>;
}

/**
 * Replace {{steps.x.y}} references with values from the run context.
 *
 * `reads` collects the step ids actually RESOLVED (not merely mentioned) — this
 * is the one place in the system that can see a dataflow edge at run time, so
 * it is where the simulation taint rule gets its input. An unresolved
 * reference contributes nothing: no value crossed, so nothing was inherited.
 */
/**
 * Look up one `{{...}}` path against the run context, without deciding how to
 * render it — that choice differs between `interpolate` (always a string, so
 * an object embedded in prose becomes JSON text) and `resolveDeep` (a step
 * argument that IS `{{steps.x.y}}` and nothing else should keep its real
 * type, so an array stays an array).
 */
function resolveReference(
  path: string,
  data: RunContext,
  reads?: Set<string>,
): { found: boolean; value: unknown } {
  const parts = path.trim().split(".");
  // `trigger.*` is the public authoring convention. Keep `steps.*` working
  // for every existing graph while exposing the start payload generically.
  let cur: unknown = parts[0] === "trigger" ? data.input : data;
  if (parts[0] === "trigger") parts.shift();
  for (const part of parts) {
    if (cur && typeof cur === "object" && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return { found: false, value: undefined };
    }
  }
  if (reads && parts[0] === "steps" && parts[1]) reads.add(parts[1]);
  return { found: true, value: cur };
}

export function interpolate(template: string, data: RunContext, reads?: Set<string>): string {
  return (template ?? "").replace(/\{\{(.*?)\}\}/g, (match, path: string) => {
    const resolved = resolveReference(path, data, reads);
    if (!resolved.found) return match; // unresolved refs are left literal
    const cur = resolved.value;
    if (cur && typeof cur === "object") {
      try {
        return JSON.stringify(cur);
      } catch {
        return String(cur);
      }
    }
    return String(cur ?? "");
  });
}

/** A step argument that is a single `{{...}}` reference and nothing else. */
const WHOLE_REFERENCE = /^\{\{([^{}]+)\}\}$/;

/**
 * Interpolate every string inside a value, however deeply nested, recording
 * what was read. `arguments` and `options` are author-supplied jsonb and can
 * legitimately hold objects and arrays, so a top-level-strings-only pass left
 * references inside them untouched.
 */
export function resolveDeep(value: unknown, ctx: ResolveScope, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    // A step argument that IS a single reference (e.g. `items:
    // "{{steps.extract.actionItems}}"`) resolves to the real value — an array
    // stays an array. Without this, `resolveDeep` fed every string through
    // `interpolate`, which always returns a string: an upstream array became
    // its JSON-text rendering, so `Array.isArray(args.items)` downstream was
    // permanently false and a tool requiring an array argument could never
    // receive one, no matter what the upstream step produced.
    const whole = value.match(WHOLE_REFERENCE);
    if (whole) {
      const resolved = resolveReference(whole[1], ctx.data, ctx.reads);
      if (resolved.found) return resolved.value;
    }
    return interpolate(value, ctx.data, ctx.reads);
  }
  if (Array.isArray(value)) return value.map((v) => resolveDeep(v, ctx, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        resolveDeep(v, ctx, depth + 1),
      ]),
    );
  }
  return value;
}

/** Throw if any string inside `value` still holds an unresolved {{...}}. */
export function assertResolved(value: unknown, label: string, depth = 0): void {
  if (depth > 8) return;
  if (typeof value === "string") {
    if (value.includes("{{")) {
      throw new Error(`${label} contains an unresolved reference: ${value.slice(0, 120)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) assertResolved(v, label, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      assertResolved(v, label, depth + 1);
    }
  }
}

/**
 * The one way a step value is turned into a comparable string.
 *
 * `filter` lower-cased and trimmed; the engine's `route()` used a bare
 * `String(value)`. So a branch on an AI-produced "Positive" fell through to
 * `default` while the equivalent filter matched — the same data, two answers,
 * depending only on which node type the author happened to pick.
 */
export function normalizeValue(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/** Parse a JSON object from a model response, tolerating fences/prose. */
export function extractJson(raw: string): Record<string, unknown> {
  let text = raw.trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\n?/i, "").replace(/```\s*$/, "");
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]) as Record<string, unknown>;
    throw new Error("Model did not return valid JSON");
  }
}

/**
 * Turn a Composio READ response into readable plain text a downstream ai_step
 * can summarize: dig for the first list of record dicts, render each record's
 * most useful fields. Falls back to compact JSON.
 */
export function flattenRecordsToText(data: unknown, limit = 50): string {
  const findList = (o: unknown, depth = 0): Record<string, unknown>[] | null => {
    if (depth > 6) return null;
    if (Array.isArray(o) && o.length && typeof o[0] === "object" && o[0] !== null) {
      return o as Record<string, unknown>[];
    }
    if (o && typeof o === "object") {
      const obj = o as Record<string, unknown>;
      for (const key of ["issues", "results", "items", "records", "data", "nodes", "orders", "products", "rows", "messages", "events"]) {
        const v = obj[key];
        if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] !== null) {
          return v as Record<string, unknown>[];
        }
      }
      for (const v of Object.values(obj)) {
        const found = findList(v, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const records = findList(data);
  if (!records) {
    try {
      return JSON.stringify(data).slice(0, 3000);
    } catch {
      return String(data).slice(0, 3000);
    }
  }

  const field = (rec: Record<string, unknown>, ...names: string[]): string => {
    for (const n of names) {
      let v = rec[n];
      if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        v = o.name ?? o.title ?? o.displayName;
      }
      if (v) return String(v);
    }
    return "";
  };

  const lines: string[] = [];
  for (const rec of records.slice(0, limit)) {
    if (!rec || typeof rec !== "object") continue;
    const title = field(rec, "title", "name", "subject", "summary");
    const state = field(rec, "state", "status");
    const desc = field(rec, "description", "body", "notes", "text");
    const meta: string[] = [];
    if (state) meta.push(`state=${state}`);
    if (rec.priority != null) meta.push(`priority=${rec.priority}`);
    let line = `- ${title || "(untitled)"}`;
    if (meta.length) line += `  [${meta.join(", ")}]`;
    if (desc) line += `\n    ${desc.slice(0, 200).replace(/\n/g, " ")}`;
    // A metrics row is all numbers — no title, no status, no body. Meta Ads
    // insights are exactly that shape, and without this the whole record
    // flattened to "- (untitled)" and the AI step downstream was handed a
    // report with no numbers in it.
    if (!title && !desc && !meta.length) {
      const scalars = Object.entries(rec)
        .filter(([, v]) => v != null && ["string", "number", "boolean"].includes(typeof v))
        .slice(0, 12)
        .map(([k, v]) => `${k}=${v}`);
      if (scalars.length) line = `- ${scalars.join(", ")}`;
    }
    lines.push(line);
  }
  return `${records.length} record(s):\n${lines.join("\n")}`;
}
