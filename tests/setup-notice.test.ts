import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { setupNotice, showSetupHints } from "@/lib/setup-notice";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const rel = (p: string) => path.relative(ROOT, p);

/**
 * Files allowed to name environment variables in a plain string.
 *
 * `env.ts` is where the names legitimately live. `registry.ts` is a vendored
 * catalog of Composio tool descriptions — third-party prose we neither wrote
 * nor show as an error. `setup-notice.ts` documents the rule.
 */
const ALLOWED_FILES = new Set([
  "src/lib/env.ts",
  "src/lib/setup-notice.ts",
  "src/lib/workflows/registry.ts",
]);

/**
 * Calls whose string arguments are not read by a customer: `setupNotice()`
 * chooses a customer-safe half itself, and `console.*` goes to server logs.
 */
const ALLOWED_CALLS = /\b(?:setupNotice|console\s*\.\s*[a-zA-Z]+)\s*\(/g;

/**
 * Variables whose spelled-out form is legitimate customer prose, so only the
 * literal SCREAMING_SNAKE name counts as a leak.
 *
 * Empty on purpose. It held `FIRECRAWL_API_KEY` while a workspace could paste
 * its own Firecrawl key, which made "Enter a valid Firecrawl API key" a real
 * instruction to a real person. Web research now runs on one server-owned key,
 * so no customer is ever asked for one and the loose form leaks again.
 */
const STRICT_ONLY = new Set<string>();

interface Literal {
  text: string;
  start: number;
  end: number;
  line: number;
}

/**
 * One pass over a source file that understands the three things a naive regex
 * gets wrong: a `//` inside a string, a quote inside a comment, and `${...}`
 * inside a template literal.
 *
 * Returns every string literal, plus a same-length copy of the source with
 * comments and string bodies blanked out. Searching that copy for a call and
 * matching its parentheses cannot be thrown off by punctuation inside prose.
 */
function scan(source: string): { literals: Literal[]; code: string } {
  const literals: Literal[] = [];
  const code = source.split("");
  let i = 0;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (code[k] !== "\n") code[k] = " ";
  };
  const lineAt = (index: number) => source.slice(0, index).split("\n").length;

  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      const end = source.indexOf("\n", i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const quote = source[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      const start = i;
      i++;
      let body = "";
      while (i < source.length) {
        const ch = source[i];
        if (ch === "\\") {
          body += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (ch === quote) {
          i++;
          break;
        }
        // A template's `${...}` holds code, not prose. Leave it in `code` so a
        // call nested in an interpolation is still found, and end the literal
        // so an interpolated expression is never mistaken for text.
        if (quote === "`" && ch === "$" && source[i + 1] === "{") {
          let depth = 1;
          let j = i + 2;
          while (j < source.length && depth > 0) {
            if (source[j] === "{") depth++;
            else if (source[j] === "}") depth--;
            j++;
          }
          literals.push({ text: body, start, end: i, line: lineAt(start) });
          body = "";
          i = j;
          continue;
        }
        body += ch;
        i++;
      }
      literals.push({ text: body, start, end: i, line: lineAt(start) });
      blank(start, i);
      continue;
    }
    i++;
  }
  return { literals, code: code.join("") };
}

/** Character ranges covered by a call this rule does not police. */
function allowedRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const match of code.matchAll(ALLOWED_CALLS)) {
    let i = (match.index ?? 0) + match[0].length;
    let depth = 1;
    while (i < code.length && depth > 0) {
      if (code[i] === "(") depth++;
      else if (code[i] === ")") depth--;
      i++;
    }
    ranges.push([match.index ?? 0, i]);
  }
  return ranges;
}

/**
 * Text a component renders as element children, e.g. `<p>Add a Twilio ...</p>`.
 *
 * This is the most user-facing form there is and the one the reported WhatsApp
 * message used, yet it is not a string literal, so scanning quoted strings
 * alone walks straight past it. Run against the blanked-out `code` from
 * `scan()`, `>text<` is a sound enough approximation: comments and string
 * bodies are already gone, and `{...}` expressions are excluded so an
 * interpolated `{setupNotice(...)}` is judged as the literal it contains.
 */
function jsxText(code: string): Array<{ text: string; line: number }> {
  const nodes: Array<{ text: string; line: number }> = [];
  for (const match of code.matchAll(/>([^<>{}]+)</g)) {
    const text = match[1];
    if (!/[A-Za-z]/.test(text)) continue;
    nodes.push({ text, line: code.slice(0, match.index ?? 0).split("\n").length });
  }
  return nodes;
}

/** The environment variables this app actually reads, straight from env.ts. */
function envVarNames(): Set<string> {
  const source = fs.readFileSync(path.join(SRC, "lib/env.ts"), "utf8");
  const names = new Set<string>();
  for (const m of source.matchAll(/pub\(\s*"([A-Z0-9_]+)"\s*\)/g)) names.add(m[1]);
  for (const m of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) names.add(m[1]);
  return names;
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Matches a variable written as code (`TWILIO_VERIFY_SERVICE_SID`) and, for
 * names of three or more parts, written out in words ("Twilio Verify Service
 * SID") — which is how the WhatsApp panel leaked without ever printing the
 * literal name. Two-part names stay strict on purpose: loosening `OPENAI_MODEL`
 * would flag the ordinary phrase "the OpenAI model", while nothing says
 * "environment variable" quite like three words of SCREAMING_SNAKE spelled out.
 */
function namingPattern(vars: Set<string>): RegExp {
  const alternatives = [...vars].map((name) => {
    const parts = name.split("_");
    const loose = parts.length >= 3 && !STRICT_ONLY.has(name);
    return loose ? parts.join("[\\s_-]+") : name;
  });
  return new RegExp(`\\b(${alternatives.join("|")})\\b`, "i");
}

/** Every string literal in `src/` that names an env var and is not exempt. */
function leaks(): string[] {
  const vars = envVarNames();
  const naming = namingPattern(vars);
  const found: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (ALLOWED_FILES.has(rel(file))) continue;
    const source = fs.readFileSync(file, "utf8");
    const { literals, code } = scan(source);
    const exempt = allowedRanges(code);
    for (const literal of literals) {
      const hit = naming.exec(literal.text);
      if (!hit) continue;
      if (exempt.some(([from, to]) => literal.start >= from && literal.end <= to)) continue;
      found.push(`${rel(file)}:${literal.line} names ${hit[1]}: ${literal.text.trim().slice(0, 90)}`);
    }
    for (const node of jsxText(code)) {
      const hit = naming.exec(node.text);
      if (!hit) continue;
      found.push(`${rel(file)}:${node.line} names ${hit[1]} in JSX text: ${node.text.trim().slice(0, 90)}`);
    }
  }
  return found;
}

test("no user-facing message names an environment variable", () => {
  const found = leaks();
  assert.deepEqual(
    found,
    [],
    "These strings can reach a real user on the live site and tell them to set an " +
      "environment variable they cannot set. Wrap each in setupNotice(userText, devHint) " +
      `from @/lib/setup-notice:\n  ${found.join("\n  ")}`,
  );
});

test("the leak scanner reads prose and skips code, comments and logs", () => {
  // Guards the guard: if the scanner quietly stopped matching, the assertion
  // above would go green for the wrong reason. Each case below is one thing it
  // has to get right.
  const vars = envVarNames();
  assert.ok(vars.has("OPENAI_API_KEY"), "env.ts extraction found no known variable");
  assert.ok(vars.has("TWILIO_VERIFY_SERVICE_SID"), "env.ts extraction missed a pub() name");

  const naming = namingPattern(vars);
  assert.match("Add a Twilio Verify Service SID to enable this.", naming);
  assert.match("Set OPENAI_API_KEY.", naming);
  // A two-part name stays strict, so ordinary prose is not flagged.
  assert.doesNotMatch("OpenAI rejected the configured model.", naming);
  // Nobody is asked for a Firecrawl key any more, so the spelled-out form is
  // an operator hint like any other.
  assert.match("Enter a valid Firecrawl API key.", naming);

  // JSX children are prose even though they are not a string literal.
  const markup = scan("<p>Add a Twilio Verify Service SID to enable this.</p>");
  assert.deepEqual(
    jsxText(markup.code).map((n) => n.text),
    ["Add a Twilio Verify Service SID to enable this."],
  );

  const sample = [
    'const bare = "Add OPENAI_API_KEY to continue.";',
    'console.error("OPENAI_API_KEY missing");',
    'const safe = setupNotice("Try again later.", "Set OPENAI_API_KEY.");',
    '// comment mentioning OPENAI_API_KEY',
    'const read = process.env.OPENAI_API_KEY;',
  ].join("\n");
  const { literals, code } = scan(sample);
  const exempt = allowedRanges(code);
  const flagged = literals
    .filter((l) => /OPENAI_API_KEY/.test(l.text))
    .filter((l) => !exempt.some(([from, to]) => l.start >= from && l.end <= to))
    .map((l) => l.text);

  assert.deepEqual(flagged, ["Add OPENAI_API_KEY to continue."]);
});

test("setupNotice shows the operator hint locally and hides it in production", () => {
  // NODE_ENV is typed read-only, so reach it through the record it really is.
  const proc = process.env as Record<string, string | undefined>;
  const original = proc.NODE_ENV;
  try {
    proc.NODE_ENV = "development";
    assert.equal(showSetupHints(), true);
    assert.equal(setupNotice("Try again later.", "Set OPENAI_API_KEY."), "Set OPENAI_API_KEY.");

    proc.NODE_ENV = "production";
    assert.equal(showSetupHints(), false);
    assert.equal(setupNotice("Try again later.", "Set OPENAI_API_KEY."), "Try again later.");

    // Fails closed: anything that is not plainly local hides the hint.
    delete proc.NODE_ENV;
    assert.equal(setupNotice("Try again later.", "Set OPENAI_API_KEY."), "Try again later.");
  } finally {
    if (original === undefined) delete proc.NODE_ENV;
    else proc.NODE_ENV = original;
  }
});
