import { strict as assert } from "node:assert";
import { test } from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appOf, connectionsOf, statusOf } from "@/lib/workflows/apps";
import { SIMULATED_APPS } from "@/lib/workflows/registry";

/**
 * A Connect button that is shown must be a Connect button that works.
 *
 * `connect-apps.tsx` renders the row and handles the press, and the two used
 * to decide "can this be connected?" from different sources:
 *
 *   - `AppStatus` asked `statusOf`, which for a server-owned app reads the ROW
 *     the connect endpoint sends;
 *   - the click handler asked `app.simulated`, a static set in registry.ts.
 *
 * They agree for every app but one — and it is the one whose OAuth client we
 * own. Google Business Profile is permanently in SIMULATED_APPS (Composio has
 * no toolkit for it), yet a deployment holding a GOOGLE_CLIENT_ID gets a
 * "none" row and therefore a Connect button. Pressing it hit the flag and
 * returned: no request, no tab, no toast. A dead button on the one integration
 * a user cannot connect any other way from inside a workflow.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = fs.readFileSync(path.join(ROOT, "src/components/connect-apps.tsx"), "utf8");

test("a configured Business Profile offers a button the handler will act on", () => {
  const gbp = appOf("googlebusinessprofile");

  // The premise of the bug: the static flag says "demo" for this app forever.
  assert.equal(gbp.simulated, true);
  assert.ok(SIMULATED_APPS.has("googlebusinessprofile"));

  // But with a Google client configured, the server states the row explicitly
  // and the resolved status is an ordinary connectable app.
  const configured = [{ platform: "googlebusinessprofile", status: "none" }];
  assert.equal(statusOf(gbp, configured, true), "none");

  // Which is exactly the status that renders a Connect button, so the handler
  // must not consult `simulated` — the two answers differ here.
  assert.notEqual(statusOf(gbp, configured, true), gbp.simulated ? "simulated" : "none");
});

test("the press handler gates on the resolved status, not the static flag", () => {
  // The regression, pinned at the source: `busy || app.simulated` is what made
  // the button dead. Guarding on `statusOf` keeps the button and the handler
  // reading one mapper, so they cannot disagree again.
  assert.ok(
    !/if\s*\(\s*busy\s*\|\|\s*app\.simulated\s*\)/.test(SOURCE),
    "connect() must not refuse on the static `simulated` flag — that is the dead-button bug",
  );
  assert.ok(
    /statusOf\(app, latest\.current\.rows, latest\.current\.live\) === "simulated"/.test(SOURCE),
    "connect() should refuse only when the RESOLVED status is demo mode",
  );
});

test("an unconfigured deployment still refuses, and says so rather than failing", () => {
  const gbp = appOf("googlebusinessprofile");

  // No row at all: no Google client here, so nothing real can happen. This is
  // the case the old flag guard got right, and it stays right.
  assert.equal(statusOf(gbp, [], true), "simulated");
  assert.equal(connectionsOf([gbp], [], true)[0].status, "simulated");

  // If a stale row ever does let a press through, the server answers
  // `simulated: true` and the user gets an explanation, not a red error.
  assert.ok(
    /if \(data\.simulated\)/.test(SOURCE),
    "a simulated answer from the server needs its own branch",
  );
  assert.ok(
    /runs in demo mode here/.test(SOURCE),
    "that branch should explain demo mode rather than report a failure",
  );
});

test("Composio-hosted apps are unaffected by the change", () => {
  // The guard now runs `statusOf` for every app, so the ordinary path has to
  // land the same way it always did: connectable when live, demo when not.
  const slack = appOf("slack");
  assert.equal(slack.simulated, false);
  assert.equal(statusOf(slack, [], true), "none");
  assert.equal(statusOf(slack, [{ platform: "slack", status: "connected" }], true), "connected");
  // No Composio key means steps.ts simulates everything, button included.
  assert.equal(statusOf(slack, [], false), "simulated");
});
