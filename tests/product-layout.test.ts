import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the product shell groups navigation around automation tasks", () => {
  const sidebar = read("src/components/app-shell/sidebar.tsx");

  assert.match(sidebar, /sidebar-primary-action/);
  assert.match(sidebar, /sidebar-section-label/);
  assert.match(sidebar, /Needs attention/);
  assert.match(sidebar, /sidebar-account/);
});

test("the create view is arranged as a focused command center", () => {
  const hub = read("src/components/workflow/automation-hub.tsx");

  assert.match(hub, /automation-command-center/);
  assert.match(hub, /automation-quick-actions/);
  assert.match(hub, /automation-template-section/);
  assert.match(hub, /Start with a common job/);
});

test("connections use a dedicated search row and labeled catalog section", () => {
  const page = read("src/app/app/integrations/page.tsx");
  const grid = read("src/components/integrations/integration-grid.tsx");

  assert.match(page, /connections-search-row/);
  assert.match(page, /catalog-section-heading/);
  assert.match(page, /Available connections/);
  assert.match(grid, /aria-label="Available integrations"/);
});

test("the arrangement stylesheet defines the new responsive hierarchy", () => {
  const css = read("src/app/globals.css");

  assert.match(css, /Product arrangement refresh/);
  assert.match(css, /\.automation-command-center\s*\{/);
  assert.match(css, /\.connections-search-row\s*\{/);
  assert.match(css, /\.sidebar-primary-action\s*\{/);
});

test("the product shell loads a dedicated warm editorial theme", () => {
  const layout = read("src/app/app/layout.tsx");
  const css = read("src/app/app/product-shell.css");

  assert.match(layout, /import "\.\/product-shell\.css"/);
  assert.match(css, /--product-paper:\s*#f7f6f3/);
  assert.match(css, /--product-ink:\s*#111111/);
  assert.match(css, /--product-line:\s*#eaeaea/);
  assert.match(css, /\.automation-command-center\s*\{/);
  assert.match(css, /\.automation-template-grid\s*\{/);
});

test("the product shell keeps primary navigation available on phones", () => {
  const css = read("src/app/app/product-shell.css");

  assert.match(css, /@media \(max-width:\s*580px\)/);
  assert.match(css, /\.product-shell \.app-sidebar\.simple-sidebar\s*\{[^}]*bottom:\s*0/s);
  assert.match(css, /padding-bottom:\s*calc\(76px \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.sidebar-nav-section:first-of-type/);
});

test("the mobile workflow editor clears the persistent navigation dock", () => {
  const css = read("src/app/app/product-shell.css");

  assert.match(css, /\.builder-shell\.growth-editor\s*\{[^}]*bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(css, /\.editor-module-panel\s*\{[^}]*display:\s*none/s);
  assert.match(css, /\.growth-inspector > footer\s*\{[^}]*bottom:\s*calc\(64px \+ env\(safe-area-inset-bottom\)\)/s);
  assert.match(css, /\.growth-editor-body\s*\{[^}]*pointer-events:\s*auto/s);
  assert.match(css, /\.canvas-add-wrap\s*\{[^}]*display:\s*block/s);
});

test("the redesigned product surface uses its own bold icon primitives", () => {
  const sidebar = read("src/components/app-shell/sidebar.tsx");
  const topbar = read("src/components/app-shell/topbar.tsx");
  const hub = read("src/components/workflow/automation-hub.tsx");
  const icons = read("src/components/ui/product-icon.tsx");

  assert.doesNotMatch(sidebar, /lucide-react/);
  assert.doesNotMatch(topbar, /lucide-react/);
  assert.doesNotMatch(hub, /lucide-react/);
  assert.match(icons, /strokeWidth=\{2\.2\}/);
  assert.match(icons, /vectorEffect="non-scaling-stroke"/);
});

test("the automation create view exposes a clear editorial brief", () => {
  const hub = read("src/components/workflow/automation-hub.tsx");

  assert.match(hub, /automation-section-label/);
  assert.match(hub, /Build from a clear brief/);
  assert.match(hub, /Describe the trigger, the work, and where a person should review/);
});
