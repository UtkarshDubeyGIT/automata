import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("modules appear only when the workflow editor was entered from creation", () => {
  const listPage = readFileSync("src/app/app/workflows/page.tsx", "utf8");
  const detailPage = readFileSync("src/app/app/workflows/[id]/page.tsx", "utf8");

  assert.match(listPage, /const href = `\/app\/workflows\/\$\{workflow\.id\}\?creating=1`/);
  assert.match(listPage, /startOpening\(\(\) => router\.push\(href\)\)/);
  assert.match(listPage, /openChat \? "\?creating=1&chat=1" : "\?creating=1"/);
  assert.match(detailPage, /searchParams\.get\("creating"\) === "1"/);
  assert.match(detailPage, /creating && modulesOpen && !chatOpen/);
});
