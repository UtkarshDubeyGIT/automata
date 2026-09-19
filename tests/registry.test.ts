import { strict as assert } from "node:assert";
import { test } from "node:test";
import { APP_LABELS, isPlaceholder, SIMULATED_APPS, TOOLS, TRIGGERS } from "@/lib/workflows/registry";

/**
 * The registry is the contract between the AI builder and the engine, and
 * until now nothing checked it. Every rule below exists because breaking it
 * fails LATE — at run time, in production, usually as a Composio 404 or the
 * thoroughly misleading "<app> is not connected".
 */

test("every argHint is valid JSON", () => {
  // It is the only schema the model is ever shown. Malformed, and the model is
  // guessing argument names from prose.
  for (const [slug, spec] of Object.entries(TOOLS)) {
    assert.doesNotThrow(() => JSON.parse(spec.argHint), `${slug} argHint is not JSON`);
  }
});

test("every required argument is one the model was actually told about", () => {
  for (const [slug, spec] of Object.entries(TOOLS)) {
    const hint = JSON.parse(spec.argHint) as Record<string, unknown>;
    for (const arg of spec.required) {
      assert.ok(arg in hint, `${slug} requires '${arg}' but never shows it in argHint`);
    }
  }
});

test("every app in the registry has a display label", () => {
  // Without one, appLabel() title-cases the slug and the palette, the
  // inspector and the connect rows all read "Metaads".
  for (const [slug, spec] of Object.entries(TOOLS)) {
    assert.ok(APP_LABELS[spec.app], `${slug} uses app '${spec.app}' with no APP_LABELS entry`);
  }
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    assert.ok(APP_LABELS[spec.app], `${slug} uses app '${spec.app}' with no APP_LABELS entry`);
  }
});

test("tool slugs are Composio-shaped", () => {
  // A lower-cased or hyphenated slug is a 404 that only shows up on a live run.
  for (const slug of Object.keys(TOOLS)) {
    assert.match(slug, /^[A-Z][A-Z0-9_]*$/, `${slug} is not a SCREAMING_SNAKE tool slug`);
  }
});

test("a poll tool that is in the registry is a read", () => {
  /*
   * Deliberately not "every pollTool is in TOOLS" — three are not
   * (GMAIL_FETCH_EMAILS, GOOGLECALENDAR_EVENTS_LIST, LINEAR_LIST_LINEAR_ISSUES)
   * and that is legal: sweep.ts calls executeTool directly, which accepts any
   * Composio slug. It does mean those three get no connection pre-check and
   * cannot be used as an app_action step, which is worth knowing but is not
   * this test's business. What IS worth failing over: a poll tool that the
   * registry claims is a WRITE, because the sweep would then be performing an
   * action every time it checked for new events.
   */
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    if (!spec.pollTool) continue;
    const tool = TOOLS[spec.pollTool];
    if (!tool) continue;
    assert.equal(tool.kind, "read", `${slug} polls with ${spec.pollTool}, which is a write`);
  }
});

test("an argument is either a person's decision or the workspace's, never both", () => {
  // `required` blocks the Active switch until a human fills it in; `autofill`
  // says the account already knows. A key in both is a step that can never be
  // switched on and never needed to be.
  for (const [slug, spec] of Object.entries(TOOLS)) {
    for (const key of Object.keys(spec.autofill ?? {})) {
      assert.ok(!spec.required.includes(key), `${slug} both requires and autofills '${key}'`);
    }
    for (const key of Object.keys(spec.defaults ?? {})) {
      assert.ok(!spec.required.includes(key), `${slug} both requires and defaults '${key}'`);
    }
  }
});

test("nothing is autofilled for a simulated app", () => {
  // The simulated branch in appAction returns before any filling happens, so
  // an autofill on a simulated app is dead code that reads as a feature.
  for (const [slug, spec] of Object.entries(TOOLS)) {
    if (!spec.autofill) continue;
    assert.ok(
      !SIMULATED_APPS.has(spec.app),
      `${slug} autofills arguments but '${spec.app}' always runs simulated`,
    );
  }
});

test("a stand-in is recognised, and a real value is left alone", () => {
  // The guard is deliberately narrow: it blanks fields, so a false positive
  // erases something a person meant.
  for (const v of ["<owner>", "<org>", "<page id>", "<channel id or #name>", "...", "…",
                   "a@b.com", "someone@example.com", "  <repo>  "]) {
    assert.ok(isPlaceholder(v), `${v} should be treated as unset`);
  }
  for (const v of ["vercel", "next.js", "primary", "#general", "C024BE91L", "Sheet1",
                   "919876543210", "order_received", "yesterday", "Team sync",
                   "hello@acme.co", "{{steps.draft.result.text}}",
                   "Fix <b>bold</b> rendering", "a < b and b > c", "1", "0",
                   // These were in the reject list once. They are ordinary
                   // answers here: a TODO sheet tab, github.com/todo/todo, a
                   // #todo channel, an event still titled TBD.
                   "TODO", "todo", "tbd", "TBD", "N/A"]) {
    assert.ok(!isPlaceholder(v), `${v} is a real value and must survive`);
  }
  for (const v of [null, undefined, "", "   "]) {
    // Blank is blank — `missingSetup` already has a test for empty, and saying
    // "placeholder" about an empty box would only muddle the message.
    assert.equal(isPlaceholder(v), false);
  }
});

test("no argHint offers the model a value the guard would reject", () => {
  /*
   * This is the defect that reached production, in its original form: the
   * catalog showed `'{"owner": "<org>", "repo": "<repo>"}'`, a model with no
   * repository to name copied it through, and the automation went live polling
   * GitHub for a repository called `<repo>`. An example the guard would refuse
   * is an example we are asking the model to get wrong.
   */
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

  for (const [slug, spec] of Object.entries(TOOLS)) {
    const bad = walk(JSON.parse(spec.argHint));
    assert.equal(bad.length, 0, `${slug} argHint offers stand-in value(s): ${bad.join(", ")}`);
  }
});

test("no trigger pre-fills a watch setting with a stand-in", () => {
  // `default` is written straight into the step when the block is inserted, so
  // a stand-in here is one the user never even sees a chance to correct.
  for (const [slug, spec] of Object.entries(TRIGGERS)) {
    for (const w of spec.watch ?? []) {
      assert.ok(
        !isPlaceholder(w.default),
        `${slug} pre-fills watch_${w.key} with '${w.default}'`,
      );
    }
  }
});

test("GitHub toolkit exposes comprehensive catalog of tools across workflows", () => {
  const githubTools = Object.values(TOOLS).filter((spec) => spec.app === "github");
  assert.ok(githubTools.length >= 800, `Expected 800+ GitHub tools, got ${githubTools.length}`);

  const slugs = new Set(Object.keys(TOOLS).filter((slug) => TOOLS[slug].app === "github"));
  assert.ok(slugs.has("GITHUB_CREATE_AN_ISSUE"));
  assert.ok(slugs.has("GITHUB_CREATE_A_PULL_REQUEST"));
  assert.ok(slugs.has("GITHUB_CREATE_A_GIST"));
  assert.ok(slugs.has("GITHUB_CREATE_A_RELEASE"));
  assert.ok(slugs.has("GITHUB_GET_THE_AUTHENTICATED_USER"));
  assert.ok(slugs.has("GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER"));
});
