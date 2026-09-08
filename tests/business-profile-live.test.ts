import { strict as assert } from "node:assert";
import { test } from "node:test";
import { limitations } from "@/lib/workflows/limitations";
import { liveWrites, validateGraph, setupGaps } from "@/lib/workflows/validate";
import { SIMULATED_APPS } from "@/lib/workflows/registry";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Google Business Profile is the one app whose demo-mode answer is not a
 * property of the app.
 *
 * It sits in `SIMULATED_APPS` permanently — Composio has no toolkit for it and
 * never will — but the OAuth client and the tokens are OURS, so `steps.ts`
 * exempts it through `runsNatively()` and a deployment holding a Google client
 * runs those steps for real. Three separate places read the static set and
 * therefore said the opposite:
 *
 *   - `limitations()` printed "produce realistic results without anything
 *     reaching Google Business Profile" on a workflow that then reached it;
 *   - `liveWrites()` left the reply step out of the Run confirmation whose
 *     entire job is to name the irreversible steps, so Run went ahead silently;
 *   - `connect-apps.tsx` refused to start the OAuth flow at all (covered in
 *     `connect-button-responds.test.ts`).
 *
 * Reported live: a personal Google account was connected, the panel promised
 * demo mode, Run posted no warning, the AI drafted a reply to the trigger's
 * canned sample review, a human approved it, and only THEN did Google refuse
 * it — "That Google account manages no business listings".
 */

const GRAPH: WorkflowGraph = {
  start: "review",
  steps: {
    review: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "reply" },
    reply: {
      type: "app_action",
      tool: "GOOGLEBUSINESS_REPLY_TO_REVIEW",
      title: "Post the reply",
      arguments: { review_id: "{{steps.review.event.review_id}}", reply: "Thank you!" },
      next: null,
    },
  },
} as WorkflowGraph;

test("the fixture is a working automation, not a broken one", () => {
  // Every claim below is about an automation that saves and validates cleanly.
  validateGraph(GRAPH);
  assert.deepEqual(setupGaps(GRAPH), {});
  assert.ok(SIMULATED_APPS.has("googlebusinessprofile"), "the static premise of the bug");
});

test("with no resolved answer the static set still applies", () => {
  // Before the status rows land, and on any caller with no workspace to ask
  // about, the old behaviour is the right one — an unconfigured deployment
  // really is demo mode, and the banner is the only thing that says so.
  const simulated = limitations(GRAPH).filter((l) => l.kind === "simulated");
  assert.equal(simulated.length, 1);
  assert.match(simulated[0].detail, /without anything reaching Google Business Profile/);
});

test("a workspace that resolved the app as live gets no demo-mode banner", () => {
  // `demoApps: []` is the editor saying "I asked, and nothing here is demo".
  const simulated = limitations(GRAPH, null, []).filter((l) => l.kind === "simulated");
  assert.deepEqual(simulated, [], "the panel must not promise nothing will reach Google");
});

test("a workspace that resolved it as demo keeps the banner", () => {
  const simulated = limitations(GRAPH, null, ["googlebusinessprofile"]).filter(
    (l) => l.kind === "simulated",
  );
  assert.equal(simulated.length, 1, "an unconfigured deployment is still demo mode");
  assert.match(simulated[0].detail, /never starts by itself/);
});

test("Run's confirmation names the reply once it really posts", () => {
  // The dialog exists to list what cannot be undone. A public reply published
  // under the business's name to a review nobody left is exactly that, and it
  // was the one thing the list left out.
  assert.deepEqual(liveWrites(GRAPH), [], "static set: nothing to warn about");

  const writes = liveWrites(GRAPH, []);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /^Post the reply — /);
  assert.match(writes[0], /Google Business Profile/);
});

test("a genuinely simulated app is still left out of the confirmation", () => {
  // The other direction: naming a step that cannot post anything would train
  // people to click through a dialog that is crying wolf.
  assert.deepEqual(liveWrites(GRAPH, ["googlebusinessprofile"]), []);
});
