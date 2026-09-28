import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  comingSoonFeaturesForGraph,
  comingSoonForStep,
  comingSoonStepsAddedSince,
} from "@/lib/workflows/availability";
import { BuildError, validateGraph } from "@/lib/workflows/validate";
import { palette } from "@/lib/workflows/blocks";
import { TEMPLATES } from "@/lib/workflows/templates";
import type { StepDef, WorkflowGraph } from "@/lib/workflows/types";

function graphFor(step: StepDef): WorkflowGraph {
  return {
    start: "trigger",
    steps: {
      trigger: { type: "manual_trigger_input", next: "target" },
      target: { ...step, next: null },
    },
  };
}

test("coming-soon registry identifies each blocked publishing/reporting capability", () => {
  const cases: [StepDef, string][] = [
    [{ type: "social_post", platform: "twitter", options: {} }, "x_publishing"],
    [{ type: "social_post", platform: "tiktok", options: {} }, "tiktok_publishing"],
    [{ type: "social_post", platform: "linkedin", options: { pageId: "company-1" } }, "linkedin_company_publishing"],
    [{ type: "app_action", toolkit: "twitter", tool: "TWITTER_CREATE_TWEET", tool_spec: { app: "twitter", kind: "write", external: true, required: [], desc: "Create a post", argHint: "{}" } }, "x_publishing"],
    [{ type: "app_action", toolkit: "tiktok", tool: "TIKTOK_PUBLISH_VIDEO", tool_spec: { app: "tiktok", kind: "write", external: true, required: [], desc: "Publish video", argHint: "{}" } }, "tiktok_publishing"],
    [{ type: "app_action", toolkit: "metaads", tool: "METAADS_GET_INSIGHTS" }, "meta_ads_actions"],
    [{ type: "app_action", toolkit: "googleads", tool: "GOOGLEADS_GET_REPORT" }, "google_ads_reports"],
    [{ type: "app_action", toolkit: "whatsapp", tool: "WHATSAPP_SEND_MESSAGE" }, "whatsapp_sends"],
    [{ type: "whatsapp_reminder" }, "whatsapp_sends"],
  ];

  for (const [step, expectedId] of cases) {
    assert.equal(comingSoonForStep(step)?.id, expectedId, JSON.stringify(step));
    assert.match(comingSoonForStep(step)?.message ?? "", /coming soon/i);
  }
});

test("LinkedIn personal publishing and non-report Google Ads reads remain available", () => {
  assert.equal(
    comingSoonForStep({ type: "social_post", platform: "linkedin", options: {} }),
    null,
  );
  assert.equal(
    comingSoonForStep({ type: "app_action", toolkit: "googleads", tool: "GOOGLEADS_LIST_ACCOUNTS" }),
    null,
  );
  assert.equal(
    comingSoonForStep({
      type: "app_action",
      toolkit: "linkedin",
      tool: "LINKEDIN_CREATE_LINKED_IN_POST",
      arguments: { author: "urn:li:person:member-1" },
    }),
    null,
  );
  assert.equal(
    comingSoonForStep({
      type: "app_action",
      toolkit: "linkedin",
      tool: "LINKEDIN_CREATE_LINKED_IN_POST",
      arguments: { author: "{{steps.lookup.result.author}}" },
    })?.id,
    "linkedin_company_publishing",
  );
});

test("graph validation rejects every blocked capability with its Coming soon message", () => {
  const blocked: StepDef[] = [
    { type: "social_post", platform: "twitter", options: {} },
    { type: "social_post", platform: "tiktok", options: {} },
    { type: "social_post", platform: "linkedin", options: { pageId: "company-1" } },
    { type: "app_action", toolkit: "metaads", tool: "METAADS_GET_INSIGHTS" },
    { type: "app_action", toolkit: "googleads", tool: "GOOGLEADS_GET_REPORT" },
    { type: "app_action", toolkit: "whatsapp", tool: "WHATSAPP_SEND_MESSAGE" },
    { type: "whatsapp_reminder" },
  ];

  for (const step of blocked) {
    const feature = comingSoonForStep(step)!;
    assert.throws(
      () => validateGraph(graphFor(step)),
      (error: Error) => error instanceof BuildError && error.message.includes(feature.message),
      JSON.stringify(step),
    );
  }
});

test("template status can be derived from the saved graph without removing its definition", () => {
  const features = comingSoonFeaturesForGraph(graphFor({
    type: "app_action",
    toolkit: "metaads",
    tool: "METAADS_GET_INSIGHTS",
  }));
  assert.deepEqual(features.map(({ id }) => id), ["meta_ads_actions"]);
});

test("blocked blocks stay visible in the picker with Coming soon metadata", () => {
  const blocks = palette();
  for (const id of ["social:twitter", "social:tiktok", "notification:whatsapp"]) {
    const block = blocks.find((candidate) => candidate.id === id);
    assert.ok(block, `${id} stays visible`);
    assert.ok(block.comingSoon, `${id} carries a Coming soon label`);
  }
  assert.ok(blocks.some((block) => block.id === "app:METAADS_GET_INSIGHTS" && block.comingSoon));
  assert.ok(blocks.some((block) => block.id === "app:GOOGLEADS_GET_REPORT" && block.comingSoon));
  assert.ok(blocks.some((block) => block.id === "app:WHATSAPP_SEND_MESSAGE" && block.comingSoon));
  assert.equal(blocks.find((block) => block.id === "social:linkedin")?.comingSoon, undefined);
});

test("affected templates remain in the catalog and retain their Coming soon graph status", () => {
  const affected = TEMPLATES.filter((template) => comingSoonFeaturesForGraph(template.graph).length > 0);
  assert.deepEqual(affected.map((template) => template.id).sort(), [
    "daily-meta-ads-report",
    "meeting-whatsapp-summary",
    "rolling-google-ads-report-gmail",
    "rolling-meta-ads-report-slack",
    "shopify-order-whatsapp",
  ]);
});

test("draft protection allows existing blocked nodes but rejects newly introduced ones", () => {
  const existing = graphFor({ type: "app_action", toolkit: "metaads", tool: "METAADS_GET_INSIGHTS" });
  assert.deepEqual(comingSoonStepsAddedSince(existing, existing), []);
  const withNewStep: WorkflowGraph = {
    ...existing,
    steps: {
      ...existing.steps,
      another: { type: "social_post", platform: "twitter", options: {}, next: null },
    },
  };
  assert.equal(comingSoonStepsAddedSince(withNewStep, existing)[0]?.id, "x_publishing");
  const removed: WorkflowGraph = {
    start: "trigger",
    steps: { trigger: { type: "manual_trigger_input", next: null } },
  };
  assert.deepEqual(comingSoonStepsAddedSince(removed, existing), []);
});
