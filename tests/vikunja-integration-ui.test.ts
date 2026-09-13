import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { INTEGRATION_BY_SLUG } from "@/lib/integrations/catalog";
import { toolkitLogo } from "@/lib/social/platforms";

const page = readFileSync("src/components/integrations/integrations-page.tsx", "utf8");
const inspector = readFileSync("src/app/app/workflows/[id]/inspector.tsx", "utf8");
const dialog = readFileSync("src/components/integrations/vikunja-connect-dialog.tsx", "utf8");

test("Vikunja is a permanent integration with its own icon", () => {
  assert.equal(INTEGRATION_BY_SLUG.get("vikunja")?.name, "Vikunja");
  assert.match(toolkitLogo("vikunja"), /vikunja\.io/);
  assert.match(page, /vikunja:\s*\{/);
  assert.match(page, /Connect Vikunja/);
  assert.equal(toolkitLogo("vikunja", "https://tasks.example.com/"), "https://tasks.example.com/images/icons/favicon.svg");
});

test("workflow setup loads Vikunja projects instead of asking for a numeric id", () => {
  assert.match(inspector, /function VikunjaProjectField/);
  assert.match(inspector, /\/api\/integrations\/vikunja\?projects=1/);
  assert.match(inspector, /Choose a Vikunja project/);
});

test("Vikunja connection UI links to token settings and offers Manage when connected", () => {
  // The form itself lives in the shared VikunjaConnectDialog (also used by
  // the workflow builder's "Accounts this automation uses" panel) — only the
  // "Manage" trigger stays on the Integrations page.
  assert.match(dialog, /Vikunja app URL/);
  assert.match(dialog, /instanceUrl:\s*url/);
  assert.match(page, />Manage</);
  assert.match(dialog, /\/api\/integrations\/vikunja/);
  assert.match(dialog, /type="password"/);
});
