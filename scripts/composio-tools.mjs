#!/usr/bin/env node
/**
 * Read the LIVE Composio catalog, so registry entries are copied rather than invented.
 *
 * src/lib/workflows/registry.ts claims its slugs are "verified against the live
 * v3 catalog" — but nothing enforced that, and nothing could: a wrong tool slug
 * or a wrong toolkit slug fails only at run time, in production, as the
 * thoroughly misleading "<app> is not connected — connect it on the
 * Integrations page" (steps.ts). This is the missing verification step.
 *
 *   node scripts/composio-tools.mjs whatsapp          # which toolkits match
 *   node scripts/composio-tools.mjs --toolkit metaads # auth + every tool + args
 *   node scripts/composio-tools.mjs --verify          # diff registry.ts vs live
 *
 * `--verify` is the half that was missing: the other two modes let you READ the
 * catalog, but nothing compared it to what the registry claims, so the header
 * comment above stayed an assertion. It checks the three things that fail late
 * and silently — a tool slug that 404s, a `required` list that under-declares
 * what the API demands (the step saves clean and dies on first run), and a
 * `realtime.needs` that no longer matches the trigger type's required config
 * (real time is refused for a reason nobody wrote down).
 *
 * NOTE ON VERSIONS — the app uses TWO, and the difference decides what this
 * script must compare against.
 *
 *   READS   (`GET /tools/...`, `/triggers_types`) pass no version, and per
 *           Composio's migration guide an unversioned v3 call resolves to the
 *           pinned `00000000_00` snapshot.
 *   EXECUTE (`POST /tools/execute/{slug}`) explicitly sends `version:
 *           "latest"` — a deliberate choice with a failure behind it, see the
 *           comment on `execute()` in src/lib/social/composio.ts: the pinned
 *           snapshot lags provider API versioning and LinkedIn's yearly
 *           sunset made it fail with NONEXISTENT_VERSION.
 *
 * A missing `required` argument fails at EXECUTION, so `latest` is what this
 * checks (`?version=latest`, which the catalog honours). The pin is reported
 * alongside only when the two disagree — that gap is worth seeing, because it
 * means the schema the editor validates against is not the schema that runs.
 *
 * Read-only: it only ever GETs. Same base URL and auth header as
 * src/lib/social/composio.ts.
 */
import fs from "node:fs";

// Same .env.local parsing as scripts/beat.mjs — the key lives in one place.
const env = {};
for (const line of fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
if (!env.COMPOSIO_API_KEY) {
  console.error("COMPOSIO_API_KEY is not set in .env.local — the catalog cannot be read without it.");
  process.exit(1);
}

const BASE = "https://backend.composio.dev/api/v3";

async function api(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (!res.ok) {
    console.error(`GET ${path} → ${res.status}`);
    console.error(typeof body === "string" ? body.slice(0, 600) : JSON.stringify(body, null, 2).slice(0, 600));
    return null;
  }
  return body;
}

/**
 * The same call, for the two verbs `--watch-probe` needs.
 *
 * Kept separate from `api()` rather than widening it, because everything else
 * in this file is read-only and the header promises exactly that. A caller that
 * can create a watch on someone's live account should have to say so.
 */
async function send(path, method, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-api-key": env.COMPOSIO_API_KEY },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Pull the first array of objects out of an unfamiliar response shape. */
function items(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  for (const key of ["items", "data", "results", "tools", "toolkits"]) {
    if (Array.isArray(body[key])) return body[key];
  }
  for (const v of Object.values(body)) {
    if (Array.isArray(v) && v.every((x) => x && typeof x === "object")) return v;
  }
  return [];
}

async function search(term) {
  const body = await api(`/toolkits?search=${encodeURIComponent(term)}&limit=25`);
  if (!body) return;
  const rows = items(body);
  if (!rows.length) {
    console.log(`No toolkit matches "${term}". Raw response:`);
    console.log(JSON.stringify(body, null, 2).slice(0, 1500));
    return;
  }
  console.log(`\n${rows.length} toolkit(s) matching "${term}":\n`);
  for (const t of rows) {
    const slug = t.slug ?? t.name ?? "?";
    const auth = t.auth_schemes ?? t.authSchemes ?? t.meta?.auth_schemes ?? [];
    console.log(`  ${String(slug).padEnd(24)} ${t.name ?? ""}`);
    if (auth.length) console.log(`  ${" ".repeat(24)} auth: ${auth.join(", ")}`);
  }
  console.log(`\nNext: node scripts/composio-tools.mjs --toolkit <slug>\n`);
}

async function toolkit(slug) {
  console.log(`\n=== toolkit: ${slug} ===\n`);

  const info = await api(`/toolkits/${encodeURIComponent(slug)}`);
  if (info) {
    const meta = info.toolkit ?? info;
    console.log(`name            : ${meta.name ?? "?"}`);
    console.log(`no auth needed  : ${meta.no_auth ?? meta.noAuth ?? false}`);
    const schemes = meta.auth_config_details ?? meta.authConfigDetails ?? [];
    const modes = (Array.isArray(schemes) ? schemes : []).map((s) => s.mode ?? s.name).filter(Boolean);
    if (modes.length) console.log(`auth schemes    : ${modes.join(", ")}`);
    const managed = meta.composio_managed_auth_schemes ?? meta.managedSchemes ?? [];
    // THE question for WhatsApp: if a scheme is managed, Composio hosts the
    // OAuth app and the user just clicks Connect. If not, the operator has to
    // register their own developer app and set COMPOSIO_OAUTH_<SLUG>_* vars.
    console.log(`composio-managed: ${managed.length ? managed.join(", ") : "(none — needs your own app)"}`);
  }

  // The tools listing is the one endpoint shape I am not certain of; try the
  // documented one and dump whatever comes back if it looks unfamiliar.
  const body = await api(`/tools?toolkit_slug=${encodeURIComponent(slug)}&limit=100`);
  if (!body) return;
  const tools = items(body);
  if (!tools.length) {
    console.log("\nNo tools parsed from the response. Raw:");
    console.log(JSON.stringify(body, null, 2).slice(0, 2000));
    return;
  }

  console.log(`\n${tools.length} tool(s):\n`);
  for (const t of tools) {
    const slugName = t.slug ?? t.name ?? "?";
    const params = t.input_parameters ?? t.inputParameters ?? t.parameters ?? {};
    const props = params.properties ?? {};
    const required = params.required ?? [];
    console.log(`  ${slugName}`);
    if (t.description) console.log(`    ${String(t.description).split("\n")[0].slice(0, 140)}`);
    if (required.length) console.log(`    required: ${required.join(", ")}`);
    const keys = Object.keys(props);
    if (keys.length) {
      // A ready-to-paste argHint: required args first, then the rest.
      const ordered = [...required, ...keys.filter((k) => !required.includes(k))].slice(0, 8);
      const hint = Object.fromEntries(ordered.map((k) => [k, `<${props[k]?.type ?? "value"}>`]));
      console.log(`    argHint : ${JSON.stringify(hint)}`);
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// --verify — registry.ts against the live pinned catalog
// ---------------------------------------------------------------------------

/**
 * Read the registry as TEXT.
 *
 * Scripts here are plain .mjs with no bundler and no tsx (scripts/AGENTS.md),
 * so importing a .ts module is not available. The two shapes below are pulled
 * out with narrow regexes, which is only safe because it fails LOUDLY: if the
 * file is reformatted so these stop matching, the parse count drops and this
 * refuses to report rather than quietly verifying nothing.
 */
function readRegistry() {
  const src = fs.readFileSync(new URL("../src/lib/workflows/registry.ts", import.meta.url), "utf8");

  const block = (name) => {
    const start = src.indexOf(`export const ${name}`);
    if (start < 0) return "";
    // To the next top-level `export`, which is where every one of these ends.
    const rest = src.slice(start + 10);
    const end = rest.indexOf("\nexport ");
    return end < 0 ? rest : rest.slice(0, end);
  };

  const tools = [];
  const toolsSrc = block("TOOLS");
  for (const m of toolsSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \{([\s\S]*?)^ {2}\},$/gm)) {
    const required = /required: \[([^\]]*)\]/.exec(m[2]);
    // An argument the WORKSPACE answers rather than the author (ToolSpec
    // .autofill, resolved in steps.ts). Deliberately absent from `required`, so
    // without reading it here the one intentional under-declaration in the
    // registry would be reported as a defect on every run — and a check that
    // always prints a problem is a check nobody reads.
    const autofill = /autofill: \{([^}]*)\}/.exec(m[2]);
    tools.push({
      slug: m[1],
      app: (/app: "([^"]+)"/.exec(m[2]) ?? [])[1],
      required: required
        ? [...required[1].matchAll(/"([^"]+)"/g)].map((r) => r[1])
        : [],
      autofill: autofill
        ? [...autofill[1].matchAll(/(\w+):/g)].map((r) => r[1])
        : [],
    });
  }

  const triggers = [];
  const trigSrc = block("TRIGGERS");
  for (const m of trigSrc.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \{([\s\S]*?)^ {2}\},$/gm)) {
    const body = m[2];
    const slugs = /slugs: \[([\s\S]*?)\]/.exec(body);
    const needs = /needs: \[([^\]]*)\]/.exec(body);
    // Every watch_* the trigger offers — the full set of config values
    // `realtime.config()` could ever supply.
    const watch = /watch: \[([\s\S]*?)^ {4}\],$/m.exec(body);
    triggers.push({
      slug: m[1],
      app: (/app: "([^"]+)"/.exec(body) ?? [])[1],
      pollTool: (/pollTool: "([^"]+)"/.exec(body) ?? [])[1],
      realtimeSlugs: slugs ? [...slugs[1].matchAll(/"([^"]+)"/g)].map((r) => r[1]) : [],
      needs: needs ? [...needs[1].matchAll(/"([^"]+)"/g)].map((r) => r[1]) : [],
      watchKeys: watch ? [...watch[1].matchAll(/key: "([^"]+)"/g)].map((r) => r[1]) : [],
    });
  }
  return { tools, triggers };
}

async function verify() {
  const { tools, triggers } = readRegistry();
  if (tools.length < 10 || triggers.length < 5) {
    console.error(
      `Parsed only ${tools.length} tools and ${triggers.length} triggers out of registry.ts — ` +
        `that is too few to be right, so the regexes above have gone stale. Fix them rather than ` +
        `trusting this run.`,
    );
    process.exit(2);
  }

  // Simulated apps have no toolkit by definition; a 404 for one is the design,
  // not a defect, so they are reported as such instead of counted as failures.
  const simulated = new Set(
    [...fs.readFileSync(new URL("../src/lib/workflows/registry.ts", import.meta.url), "utf8")
      .matchAll(/SIMULATED_APPS = new Set\(\[([^\]]*)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/"([^"]+)"/g)].map((r) => r[1])),
  );

  const problems = [];
  console.log(`
=== ${tools.length} tools, at the version execute() runs (latest) ===
`);
  for (const tool of tools) {
    // `latest` first: that is the implementation `execute()` actually invokes.
    const r = await api(`/tools/${encodeURIComponent(tool.slug)}?version=latest`);
    if (!r) {
      if (simulated.has(tool.app)) {
        console.log(`  ${tool.slug.padEnd(34)} no toolkit — simulated by design (${tool.app})`);
      } else {
        console.log(`  ${tool.slug.padEnd(34)} MISSING from the live catalog`);
        problems.push(`${tool.slug} is not a live tool slug`);
      }
      continue;
    }
    const t = r.item ?? r.data ?? r;
    const params = t.input_parameters ?? t.inputParameters ?? {};
    const live = params.required ?? [];

    // The pinned snapshot, purely to surface a divergence. Not authoritative:
    // nothing executes against it.
    const pinnedRes = await api(`/tools/${encodeURIComponent(tool.slug)}`);
    const pinned = pinnedRes
      ? ((pinnedRes.item ?? pinnedRes.data ?? pinnedRes).input_parameters ?? {}).required ?? []
      : [];
    const diverged =
      pinned.length !== live.length || pinned.some((k) => !live.includes(k));
    // Only UNDER-declaring is a defect. Requiring more than the API does is how
    // the registry front-loads a failure into the editor on purpose.
    const autofilled = live.filter(
      (k) => !tool.required.includes(k) && tool.autofill.includes(k),
    );
    const under = live.filter(
      (k) => !tool.required.includes(k) && !tool.autofill.includes(k),
    );
    const note = under.length
      ? `UNDER-DECLARES ${under.join(", ")}`
      : autofilled.length
        ? `ok (${autofilled.join(", ")} autofilled)`
        : "ok";
    console.log(
      `  ${tool.slug.padEnd(34)} v=${t.version ?? "?"} required=[${live.join(",")}] ${note}` +
        (diverged ? `\n  ${" ".repeat(34)} pinned 00000000_00 differs: [${pinned.join(",")}]` : ""),
    );
    if (under.length) {
      problems.push(
        `${tool.slug} does not require ${under.join(", ")}, which the API does — ` +
          `that step saves clean and fails on its first run. Either add it to ` +
          `\`required\`, or give it an \`autofill\` source if the workspace already knows it`,
      );
    }
  }

  console.log(`
=== ${triggers.length} triggers ===
`);
  for (const trig of triggers) {
    if (trig.pollTool) {
      const r = await api(`/tools/${encodeURIComponent(trig.pollTool)}`);
      if (!r && !simulated.has(trig.app)) {
        console.log(`  ${trig.slug.padEnd(24)} poll tool ${trig.pollTool} MISSING`);
        problems.push(`${trig.slug}'s pollTool ${trig.pollTool} is not a live tool slug`);
      }
    }
    if (!trig.realtimeSlugs.length) {
      console.log(`  ${trig.slug.padEnd(24)} poll only`);
      continue;
    }
    const body = await api(`/triggers_types?toolkit_slugs=${encodeURIComponent(trig.app)}&limit=100`);
    const types = items(body ?? {});
    // EVERY candidate the toolkit publishes, in preference order — the same
    // list `enable()` walks. Judging only the first was wrong once Linear
    // started relying on a second, laxer candidate.
    const found = trig.realtimeSlugs
      .map((want) => types.find((t) => String(t.slug).toUpperCase() === want.toUpperCase()))
      .filter(Boolean);
    if (!found.length) {
      console.log(
        `  ${trig.slug.padEnd(24)} no preferred slug exists in ${trig.app} (${types.length} types) — polls`,
      );
      // Not a problem: falling back to polling is the designed behaviour, and
      // Shopify legitimately publishes no trigger types at all.
      continue;
    }

    // What `enable()` would land on with nothing filled in, and with
    // everything filled in. Only the second being empty is a defect.
    const blank = found.find((t) => !(t.config?.required ?? []).length);
    const filled = found.find((t) =>
      (t.config?.required ?? []).every((k) => trig.watchKeys.includes(k)),
    );
    const chosen = filled ?? found[0];
    const deprecated = /deprecated/i.test(chosen.description ?? "");
    console.log(
      `  ${trig.slug.padEnd(24)} ${chosen.slug} (${chosen.type}) ` +
        `requires=[${(chosen.config?.required ?? []).join(",")}] ` +
        `blank-setup=${blank ? blank.slug : "none — polls until filled"}` +
        `${deprecated ? " DEPRECATED" : ""}`,
    );
    if (!filled) {
      problems.push(
        `${trig.slug}: no candidate's required config can be supplied from its watch fields ` +
          `(${found.map((t) => `${t.slug} needs ${(t.config?.required ?? []).join("+") || "nothing"}`).join("; ")}) — ` +
          `real time is unreachable with no field to fix it`,
      );
    } else if (!blank && !trig.needs.length) {
      problems.push(
        `${trig.slug} can only go real-time once ${(filled.config?.required ?? []).join(", ")} ` +
          `is filled in, but declares no realtime.needs — the editor will not tell anyone`,
      );
    }
    if (deprecated) {
      problems.push(`${trig.slug} resolves to ${chosen.slug}, which Composio marks DEPRECATED`);
    }
  }

  console.log("");
  if (!problems.length) {
    console.log("registry.ts agrees with the live catalog.\n");
    return;
  }
  console.log(`${problems.length} problem(s):\n`);
  for (const p of problems) console.log(`  - ${p}`);
  console.log("");
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// --watch-probe — can each trigger ACTUALLY be subscribed, and push or poll?
// ---------------------------------------------------------------------------

/**
 * `--verify` reads the catalog; this one writes to it.
 *
 * The gap it closes: every claim the product makes about real time was, until
 * this ran, a claim about a code path nobody had executed. `trigger_instances/
 * active` was empty, so no watch had ever been created and no pushed event had
 * ever arrived — the sweep's fallback was the only thing that had been proven.
 * Reading the catalog cannot tell you this, because a trigger type existing and
 * a trigger type accepting YOUR account with YOUR config are different
 * questions, and only the second one is what a user is promised.
 *
 * For each trigger it resolves the type the way `realtime.ts` does, fits the
 * config, creates the watch on a real connected account, reads back what
 * Composio says it is (`webhook` = a genuine push, `poll` = Composio polling on
 * its own interval), and then removes it.
 *
 * SAFE BY CONSTRUCTION, in one specific way worth stating: the instances it
 * creates belong to no workflow. The inbound route resolves a delivery by
 * looking up `trigger_state->realtime->>instanceId`, so an event arriving for
 * one of these matches nothing and changes nothing — it cannot fire somebody's
 * automation. Teardown still runs in a finally, because leaving live watches on
 * a user's account is its own kind of rude.
 */
async function watchProbe() {
  const { triggers } = readRegistry();
  if (triggers.length < 5) {
    console.error("Parsed too few triggers out of registry.ts — fix the regexes in readRegistry().");
    process.exit(2);
  }

  const accounts = items(await api("/connected_accounts?limit=100"));
  const accountFor = (app) =>
    accounts.find(
      (a) => (a.toolkit?.slug ?? "").toLowerCase() === app.toLowerCase() && a.status === "ACTIVE",
    );

  const src = fs.readFileSync(new URL("../src/lib/workflows/registry.ts", import.meta.url), "utf8");
  const simulated = new Set(
    [...src.matchAll(/SIMULATED_APPS = new Set\(\[([^\]]*)\]/g)].flatMap((m) =>
      [...m[1].matchAll(/"([^"]+)"/g)].map((r) => r[1]),
    ),
  );

  const sub = items(await api("/webhook_subscriptions"))[0];
  console.log(`\n=== delivery endpoint ===\n`);
  console.log(
    sub
      ? `  ${sub.webhook_url}\n  events: ${(sub.enabled_events ?? []).join(", ")}`
      : "  NONE REGISTERED — nothing can ever be pushed, whatever the watches say",
  );

  console.log(`\n=== ${triggers.length} triggers, subscribed for real ===\n`);
  const results = [];

  for (const trig of triggers) {
    const row = { slug: trig.slug, app: trig.app };
    results.push(row);

    if (simulated.has(trig.app)) {
      row.verdict = "n/a";
      row.detail = "no Composio toolkit — simulated by design";
      continue;
    }
    if (!trig.realtimeSlugs.length) {
      row.verdict = "poll-only";
      row.detail = "registry declares no realtime candidates";
      continue;
    }
    const account = accountFor(trig.app);
    if (!account) {
      row.verdict = "blocked";
      row.detail = `no ACTIVE ${trig.app} account connected — cannot subscribe`;
      continue;
    }

    const types = items(await api(`/triggers_types?toolkit_slugs=${encodeURIComponent(trig.app)}&limit=100`));
    if (!types.length) {
      row.verdict = "poll-only";
      row.detail = `${trig.app} publishes no trigger types at all`;
      continue;
    }
    const bySlug = new Map(types.map((t) => [String(t.slug ?? "").toUpperCase(), t]));
    const chosen = trig.realtimeSlugs.map((c) => bySlug.get(c.toUpperCase())).find(Boolean);
    if (!chosen) {
      row.verdict = "poll-only";
      row.detail = `none of ${trig.realtimeSlugs.join(", ")} exists in ${trig.app}`;
      continue;
    }

    // Only the keys this type declares, exactly as `fitConfig` does — an
    // undeclared key is a 400, and a missing required one is why a watch that
    // "should" push quietly polls instead.
    const props = chosen.config?.properties ?? {};
    const required = chosen.config?.required ?? [];
    const config = {};
    for (const key of required) {
      if (!(key in props)) continue;
      const probeValue = PROBE_CONFIG[`${trig.app}.${key}`];
      if (probeValue !== undefined) config[key] = probeValue;
    }
    const unmet = required.filter((k) => config[k] === undefined);
    if (unmet.length) {
      row.verdict = "needs-config";
      row.detail = `${chosen.slug} requires ${unmet.join(", ")} — add a value to PROBE_CONFIG to test it`;
      continue;
    }

    let created;
    try {
      created = await send(`/trigger_instances/${encodeURIComponent(chosen.slug)}/upsert`, "POST", {
        user_id: account.user_id,
        trigger_config: config,
      });
      if (!created.ok) {
        row.verdict = "FAILED";
        // Name the account. A 400 here is usually about PERMISSIONS on the
        // chosen target rather than about the trigger — GitHub will not create
        // a webhook on a repo the connected account lacks admin on, and says
        // only "not found" — so which account asked is the first thing to know.
        const why =
          typeof created.body?.error?.message === "string"
            ? created.body.error.message
            : JSON.stringify(created.body).slice(0, 160);
        row.detail = `${chosen.slug} refused (${created.status}) for account ${account.id}: ${why}`;
        continue;
      }
      const id = created.body?.trigger_id ?? created.body?.triggerId ?? created.body?.id;
      // What Composio says it IS, not what we hoped. `webhook` is a genuine
      // push; `poll` means Composio polls on its own interval and the UI must
      // not say "runs in real time".
      const live = items(await api("/trigger_instances/active")).find((t) => (t.id ?? t.trigger_id) === id);
      row.verdict = "SUBSCRIBED";
      // What Composio calls it, not what we hoped for. Only `webhook` is a
      // genuine push — `poll` means Composio polls the provider on its own
      // interval, which still beats our hourly sweep but is a different promise.
      row.channel = chosen.type;
      row.detail =
        `${chosen.slug} (${chosen.type}) instance=${id}` +
        (live ? " — confirmed active" : " — created but NOT listed as active");
      row.instanceId = id;
    } finally {
      if (row.instanceId) {
        // Disable, not delete — the same call `disableTriggerInstance` makes,
        // so the teardown path this probe exercises is the one production uses.
        const off = await send(
          `/trigger_instances/manage/${encodeURIComponent(row.instanceId)}`,
          "PATCH",
          { status: "disable" },
        );
        row.detail += off.ok ? " — disabled" : ` — TEARDOWN FAILED (${off.status}), disable it by hand`;
      }
    }
  }

  const pad = Math.max(...results.map((r) => r.slug.length));
  for (const r of results) {
    console.log(`  ${r.slug.padEnd(pad)}  ${String(r.verdict).padEnd(12)} ${r.detail}`);
  }

  const failed = results.filter((r) => r.verdict === "FAILED");
  console.log(
    `\n  ${results.filter((r) => r.verdict === "SUBSCRIBED").length} subscribed, ` +
      `${results.filter((r) => r.verdict === "blocked").length} blocked on a connection, ` +
      `${results.filter((r) => r.verdict === "poll-only" || r.verdict === "n/a").length} cannot push by nature, ` +
      `${failed.length} failed\n`,
  );
  if (failed.length) process.exitCode = 1;
}

/**
 * Values for trigger config the probe cannot invent.
 *
 * A watch on "issues in a repository" needs a repository; there is no generic
 * answer, and a wrong one is a 404 that reads like a broken integration. Keyed
 * `<toolkit>.<config key>`; anything absent is reported as needs-config rather
 * than guessed.
 */
const probeEnv = (name) => process.env[name] ?? env[name];
const PROBE_CONFIG = {
  "github.owner": probeEnv("PROBE_GITHUB_OWNER"),
  "github.repo": probeEnv("PROBE_GITHUB_REPO"),
  "slack.channel": probeEnv("PROBE_SLACK_CHANNEL"),
  "linear.team_id": probeEnv("PROBE_LINEAR_TEAM_ID"),
};

const args = process.argv.slice(2);
const i = args.indexOf("--toolkit");
if (args.includes("--verify")) await verify();
else if (args.includes("--watch-probe")) await watchProbe();
else if (i >= 0 && args[i + 1]) await toolkit(args[i + 1]);
else if (args[0]) await search(args[0]);
else {
  console.error(
    "usage: composio-tools.mjs <search term> | --toolkit <slug> | --verify | --watch-probe",
  );
  process.exit(1);
}
