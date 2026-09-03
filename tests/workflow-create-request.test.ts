import assert from "node:assert/strict";
import test from "node:test";

async function subject() {
  return import("@/lib/workflows/create-request").catch(() => null);
}

const workflow = {
  id: "wf-created", name: "Created workflow", desc: "Created once", active: false,
  schedule: "Manual", lastRun: "never", runs: 0, success: "—", groups: [],
};

test("concurrent calls for one creation attempt share one request", async () => {
  const createRequest = await subject();
  assert.ok(createRequest, "the workflow creation request helper must exist");
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    calls++;
    await blocked;
    return Response.json({ workflow, duplicate: false });
  }) as typeof fetch;
  const first = createRequest.requestWorkflowCreation("chat:build-1", { buildId: "build-1" }, fetchImpl);
  const second = createRequest.requestWorkflowCreation("chat:build-1", { buildId: "build-1" }, fetchImpl);
  release();
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test("a retry after an unknown response reuses the creation nonce", async () => {
  const createRequest = await subject();
  assert.ok(createRequest, "the workflow creation request helper must exist");
  const nonces: string[] = [];
  let attempt = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    nonces.push(new Headers(init?.headers).get("x-workflow-nonce") ?? "");
    if (attempt++ === 0) throw new TypeError("network connection closed");
    return Response.json({ workflow, duplicate: true });
  }) as typeof fetch;
  assert.deepEqual(await createRequest.requestWorkflowCreation("template:blank", { template: "blank" }, fetchImpl), { kind: "unknown" });
  assert.equal((await createRequest.requestWorkflowCreation("template:blank", { template: "blank" }, fetchImpl)).kind, "created");
  assert.equal(nonces.length, 2);
  assert.equal(nonces[0], nonces[1]);
});

test("a parseable refusal settles the attempt so the next click gets a new nonce", async () => {
  const createRequest = await subject();
  assert.ok(createRequest, "the workflow creation request helper must exist");
  const nonces: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    nonces.push(new Headers(init?.headers).get("x-workflow-nonce") ?? "");
    return Response.json({ error: "No workflow" }, { status: 400 });
  }) as typeof fetch;
  await createRequest.requestWorkflowCreation("template:reports", { template: "reports" }, fetchImpl);
  await createRequest.requestWorkflowCreation("template:reports", { template: "reports" }, fetchImpl);
  assert.notEqual(nonces[0], nonces[1]);
});
