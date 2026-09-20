import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const accountMenu = readFileSync("src/components/app-shell/app-controls.tsx", "utf8");
const settings = readFileSync("src/app/app/settings/page.tsx", "utf8");

test("sign-out controls use the shared confirmation flow", () => {
  assert.match(accountMenu, /<SignOutButton\s+menuItem\s*\/>/);
  assert.match(settings, /<SignOutButton\s*\/>/);
});

test("the shared sign-out flow requires confirmation and uses danger styling", () => {
  const file = "src/components/sign-out-button.tsx";
  assert.ok(existsSync(file), "expected a shared sign-out button component");
  const source = readFileSync(file, "utf8");
  assert.match(source, /title="Sign out\?"/);
  assert.match(source, /<form action=\{signOutAction\}>/);
  assert.match(source, /variant="danger"/);
});
