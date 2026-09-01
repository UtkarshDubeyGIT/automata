import assert from "node:assert/strict";
import test from "node:test";

import { BRAND } from "@/config/brand";

test("the working brand is centralized and rename-ready", () => {
  assert.equal(BRAND.name, "Automata");
  assert.equal(BRAND.repo, "automata");
  assert.ok(BRAND.tagline.length > 10);
  assert.ok(BRAND.supportEmail.includes("@"));
});
