import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  connectionsOf,
  needsBrandGrounding,
  requiredAppsOf,
  statusOf,
  unconnected,
} from "@/lib/workflows/apps";
import { getTemplate } from "@/lib/workflows/templates";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * Which accounts an automation needs, and whether this workspace has them.
 *
 * This is the answer the create paths gate on, so the two ways to get it wrong
 * both matter: claiming an app is connected when it isn't lets someone build
 * an automation that fails on its first step, and claiming one isn't when it
 * is (or can't be) blocks a create button over nothing.
 */

const GRAPH: WorkflowGraph = {
  start: "review",
  steps: {
    review: { type: "app_event_trigger", event: "NEW_GOOGLE_REVIEW", next: "notify" },
    notify: {
      type: "app_action",
      tool: "SLACK_FETCH_CONVERSATION_HISTORY",
      arguments: { channel: "#alerts" },
      next: "post",
    },
    post: { type: "social_post", platform: "linkedin", text: "hello", next: null },
  },
} as WorkflowGraph;

test("every kind of step contributes the account it needs", () => {
  // A trigger's app, an app_action's toolkit and a social channel are three
  // different lookups and all three are things the user has to connect.
  const apps = requiredAppsOf(GRAPH).map((a) => a.app).sort();
  assert.deepEqual(apps, ["googlebusinessprofile", "linkedin", "slack"]);

  // Named the way the user knows them, not by slug.
  const labels = Object.fromEntries(requiredAppsOf(GRAPH).map((a) => [a.app, a.label]));
  assert.equal(labels.googlebusinessprofile, "Google Business Profile");
  assert.equal(labels.linkedin, "LinkedIn");
});

test("an app with no toolkit is demo mode, never 'connected'", () => {
  /*
   * `POST /api/integrations/connect` writes a cached `connected` row for an
   * app with no Composio toolkit, so the row really does say connected — and
   * every call against it is still a fabrication. The status is derived from
   * the app, not from the row, so that row cannot make the UI claim otherwise.
   */
  const [gbp] = requiredAppsOf(GRAPH).filter((a) => a.app === "googlebusinessprofile");
  assert.equal(gbp.simulated, true);
  assert.equal(
    statusOf(gbp, [{ platform: "googlebusinessprofile", status: "connected" }], true),
    "simulated",
  );
  // And it is never something the user can be asked to go and fix.
  assert.deepEqual(unconnected(connectionsOf([gbp], [], true)), []);
});

test("with no Composio key the whole install is demo mode", () => {
  // steps.ts simulates every app_action when `socialProvider.live` is false,
  // so reporting Slack as connected there would be the same lie relocated.
  const [slack] = requiredAppsOf(GRAPH).filter((a) => a.app === "slack");
  assert.equal(statusOf(slack, [{ platform: "slack", status: "connected" }], false), "simulated");
  assert.equal(statusOf(slack, [{ platform: "slack", status: "connected" }], true), "connected");
});

test("only a finished connection clears the gate", () => {
  const [slack] = requiredAppsOf(GRAPH).filter((a) => a.app === "slack");
  assert.equal(statusOf(slack, [], true), "none");
  // OAuth opened in a tab and never finished: there is still no account.
  assert.equal(statusOf(slack, [{ platform: "slack", status: "pending" }], true), "pending");
  assert.equal(
    unconnected(connectionsOf([slack], [{ platform: "slack", status: "pending" }], true)).length,
    1,
  );
});

test("a status we could not fetch blocks nothing", () => {
  /*
   * `unknown` means our own endpoint did not answer. Treating that as "not
   * connected" would disable the create button over a network blip, with
   * nothing the user could do about it — so it is deliberately not blocking.
   */
  const [slack] = requiredAppsOf(GRAPH).filter((a) => a.app === "slack");
  assert.equal(statusOf(slack, null, true), "unknown");
  assert.deepEqual(unconnected(connectionsOf([slack], null, true)), []);
});

test("the shipped templates all declare the accounts they run on", () => {
  // The template gallery gates on this, so a template whose graph names no app
  // would create silently — which is exactly the behaviour being replaced.
  const reviews = getTemplate("google-review-replies");
  assert.ok(reviews);
  assert.deepEqual(
    requiredAppsOf(reviews.graph).map((a) => a.app),
    ["googlebusinessprofile"],
  );

  const github = getTemplate("urgent-issue-triage");
  assert.ok(github);
  assert.ok(requiredAppsOf(github.graph).some((a) => a.app === "github"));
});

/**
 * Which graphs have to know what the business is.
 *
 * The distinction is "does this step GENERATE something", not "does it touch
 * an AI". Publishing text a previous step wrote, reading a repo, routing on a
 * value — none of those get better or worse for knowing what the company
 * sells, and raising the notice over them would teach people to ignore it.
 */
test("a graph that only moves data needs no brand profile", () => {
  assert.equal(needsBrandGrounding(GRAPH), false);
});

test("an AI step means the output is written, so the brand matters", () => {
  assert.equal(
    needsBrandGrounding({
      start: "t",
      steps: {
        t: { type: "manual_trigger_input", next: "draft" },
        draft: { type: "ai_step", instruction: "write something", next: null },
      },
    }),
    true,
  );
});

test("an image step counts too — a picture is as much about the business as the copy", () => {
  // Regression: the editor used to test for `ai_step` by hand, so a workflow
  // whose only generated output was an image raised nothing at all.
  assert.equal(
    needsBrandGrounding({
      start: "t",
      steps: {
        t: { type: "manual_trigger_input", next: "pic" },
        pic: { type: "generate_image", prompt: "the product", next: null },
      },
    }),
    true,
  );
});
