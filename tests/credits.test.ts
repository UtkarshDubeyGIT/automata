import assert from "node:assert/strict";
import test from "node:test";

import { creditCost } from "@/lib/workflows/credits";

test("connected app and HTTP modules consume one credit per successful execution", () => {
  assert.equal(creditCost({ type: "app_action", outcome: "succeeded" }), 1);
  assert.equal(creditCost({ type: "http_request", outcome: "succeeded" }), 1);
});

test("flow-control modules and failed modules consume no credits", () => {
  assert.equal(creditCost({ type: "filter", outcome: "succeeded" }), 0);
  assert.equal(creditCost({ type: "app_action", outcome: "failed" }), 0);
});

test("AI modules consume their measured provider credits", () => {
  assert.equal(creditCost({ type: "ai", outcome: "succeeded", providerCredits: 3 }), 3);
  assert.equal(creditCost({ type: "image", outcome: "succeeded", providerCredits: 8 }), 8);
});
