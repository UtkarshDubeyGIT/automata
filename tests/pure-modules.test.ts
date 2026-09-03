import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(import.meta.dirname, "..", "src");

/** Modules that reach a real provider, a real database, or a secret. */
const PROVIDERS = [
  "@/lib/ai/openai",
  "@/lib/ai/image",
  "@/lib/social/composio",
  "@/lib/billing/stripe",
  "@/lib/video/higgsfield",
  "@/lib/supabase/server",
  "@/lib/credits",
  "@/lib/env",
];

function resolve(specifier: string, fromFile: string): string | null {
  let base: string;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function isServerActions(file: string): boolean {
  return /^\s*["']use server["']/.test(fs.readFileSync(file, "utf8"));
}

function importsOf(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const source = fs.readFileSync(file, "utf8");
  const found: string[] = [];
  const re = /(?:^|\n)\s*(?:import|export)\s+([\s\S]*?)\s*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const m of source.matchAll(re)) {
    const clause = m[1] ?? "";
    const specifier = m[2] ?? m[3];
    if (!specifier) continue;
    if (/^type\b/.test(clause.trim())) continue;
    found.push(specifier);
  }
  return found;
}

function providerReachedFrom(entry: string): string[] | null {
  if (!fs.existsSync(entry)) return null;
  const seen = new Set<string>();
  const queue: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];
  while (queue.length) {
    const { file, trail } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsOf(file)) {
      if (PROVIDERS.includes(specifier)) return [...trail, specifier];
      const next = resolve(specifier, file);
      if (next && !seen.has(next) && !isServerActions(next)) {
        queue.push({ file: next, trail: [...trail, next] });
      }
    }
  }
  return null;
}

const rel = (p: string) => path.relative(path.join(SRC, ".."), p);

test("the approval preview builder never reaches a provider client", () => {
  const trail = providerReachedFrom(path.join(SRC, "lib/workflows/preview.ts"));
  assert.equal(
    trail,
    null,
    `preview.ts reaches a provider: ${(trail ?? []).map(rel).join("\n  -> ")}`,
  );
});

test("the pure workflow modules the editor lints on stay pure", () => {
  for (const name of ["validate", "limitations", "apps", "layout", "interpolate"]) {
    const trail = providerReachedFrom(path.join(SRC, `lib/workflows/${name}.ts`));
    assert.equal(
      trail,
      null,
      `${name}.ts reaches a provider: ${(trail ?? []).map(rel).join("\n  -> ")}`,
    );
  }
});

test("browser workflow components never reach a provider client", () => {
  const components = [
    "app/(app)/workflows/approval-preview.tsx",
    "app/(app)/workflows/workflow-logo.tsx",
    "app/(app)/workflows/[id]/canvas.tsx",
    "app/(app)/workflows/[id]/step-picker.tsx",
    "app/(app)/workflows/[id]/inspector.tsx",
    "app/(app)/integrations/page.tsx",
    "components/connect-apps.tsx",
  ];
  for (const component of components) {
    const filePath = path.join(SRC, component);
    if (!fs.existsSync(filePath)) continue;
    const trail = providerReachedFrom(filePath);
    assert.equal(
      trail,
      null,
      `${component} reaches a provider: ${(trail ?? []).map(rel).join("\n  -> ")}`,
    );
  }
});

test("the graph is walked, not just the direct imports", () => {
  const trail = providerReachedFrom(path.join(SRC, "lib/workflows/engine.ts"));
  assert.ok(trail, "engine.ts should reach a provider through steps.ts");
  assert.ok(trail!.length >= 3, `expected a multi-hop trail, got ${trail!.map(rel).join(" -> ")}`);
});
