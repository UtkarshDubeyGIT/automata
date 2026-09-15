import { strict as assert } from "node:assert";
import { test } from "node:test";
import { bucketConnections, type RawConnectedAccount } from "@/lib/social/composio";

function row(id: string, status: string, slug: string): RawConnectedAccount {
  return { id, status, toolkit: { slug } };
}

test("an ACTIVE account reads as connected, with its account id", () => {
  const out = bucketConnections([row("acc-1", "ACTIVE", "slack")]);
  assert.deepEqual(out, [{ platform: "slack", status: "connected", accountId: "acc-1" }]);
});

test("INITIATED and INITIALIZING both read as pending", () => {
  assert.deepEqual(
    bucketConnections([row("acc-1", "INITIATED", "slack")]),
    [{ platform: "slack", status: "pending", accountId: "acc-1" }],
  );
  assert.deepEqual(
    bucketConnections([row("acc-1", "INITIALIZING", "slack")]),
    [{ platform: "slack", status: "pending", accountId: "acc-1" }],
  );
});

test("a toolkit with only dead accounts reads as disconnected, with no account id", () => {
  for (const status of ["EXPIRED", "FAILED", "INACTIVE"]) {
    assert.deepEqual(
      bucketConnections([row("acc-1", status, "slack")]),
      [{ platform: "slack", status: "disconnected", accountId: null }],
    );
  }
});

test("several dead accounts for one slug still collapse to a single disconnected entry", () => {
  const out = bucketConnections([
    row("acc-1", "EXPIRED", "slack"),
    row("acc-2", "FAILED", "slack"),
    row("acc-3", "INACTIVE", "slack"),
  ]);
  assert.deepEqual(out, [{ platform: "slack", status: "disconnected", accountId: null }]);
});

test("an ACTIVE account wins over a dead one for the same slug, in either order", () => {
  const deadFirst = bucketConnections([
    row("acc-1", "EXPIRED", "slack"),
    row("acc-2", "ACTIVE", "slack"),
  ]);
  const activeFirst = bucketConnections([
    row("acc-2", "ACTIVE", "slack"),
    row("acc-1", "EXPIRED", "slack"),
  ]);
  for (const out of [deadFirst, activeFirst]) {
    assert.deepEqual(out, [{ platform: "slack", status: "connected", accountId: "acc-2" }]);
  }
});

test("an ACTIVE account wins over a pending one for the same slug, in either order", () => {
  const pendingFirst = bucketConnections([
    row("acc-1", "INITIATED", "slack"),
    row("acc-2", "ACTIVE", "slack"),
  ]);
  const activeFirst = bucketConnections([
    row("acc-2", "ACTIVE", "slack"),
    row("acc-1", "INITIATED", "slack"),
  ]);
  for (const out of [pendingFirst, activeFirst]) {
    assert.deepEqual(out, [{ platform: "slack", status: "connected", accountId: "acc-2" }]);
  }
});

test("an abandoned INITIATED attempt only claims a slug nothing else has yet", () => {
  const out = bucketConnections([
    row("acc-1", "INITIATED", "slack"),
    row("acc-2", "INITIATED", "slack"),
  ]);
  assert.deepEqual(out, [{ platform: "slack", status: "pending", accountId: "acc-1" }]);
});

test("distinct toolkits bucket independently", () => {
  const out = bucketConnections([
    row("acc-1", "ACTIVE", "slack"),
    row("acc-2", "EXPIRED", "gmail"),
    row("acc-3", "INITIATED", "facebook"),
  ]);
  assert.deepEqual(
    new Map(out.map((c) => [c.platform, c])),
    new Map([
      ["slack", { platform: "slack", status: "connected", accountId: "acc-1" }],
      ["gmail", { platform: "gmail", status: "disconnected", accountId: null }],
      ["facebook", { platform: "facebook", status: "pending", accountId: "acc-3" }],
    ]),
  );
});

test("no accounts at all bucket to nothing", () => {
  assert.deepEqual(bucketConnections([]), []);
});
