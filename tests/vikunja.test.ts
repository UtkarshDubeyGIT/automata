import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  VikunjaError,
  createVikunjaClient,
  type VikunjaProject,
} from "@/lib/integrations/vikunja";

test("Vikunja client authenticates and lists writable projects", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVikunjaClient("secret-token", async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json([
      { id: 21, title: "Operations", is_archived: false, max_permission: 1 },
      { id: 22, title: "Archive", is_archived: true, max_permission: 2 },
      { id: 23, title: "Read only", is_archived: false, max_permission: 0 },
    ] satisfies VikunjaProject[]);
  });

  const projects = await client.listProjects();

  assert.deepEqual(projects.map((project) => project.id), [21]);
  assert.equal(calls[0]?.url, "https://vikunja.doubtbuddy.com/api/v1/projects?expand=permissions&per_page=100");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret-token");
});

test("Vikunja client creates an unassigned task in the selected project", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = createVikunjaClient("token", async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ id: 88, title: "Send proposal", description: "Owner mentioned: Alex" }, { status: 201 });
  });

  const task = await client.createTask(21, {
    title: "Send proposal",
    description: "Owner mentioned: Alex",
  });

  assert.equal(task.id, 88);
  assert.equal(request?.url, "https://vikunja.doubtbuddy.com/api/v1/projects/21/tasks");
  assert.equal(request?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    title: "Send proposal",
    description: "Owner mentioned: Alex",
  });
});

test("Vikunja client classifies rejected credentials without exposing the token", async () => {
  const client = createVikunjaClient("never-print-this", async () =>
    Response.json({ code: 1011, message: "Wrong credentials: never-print-this" }, { status: 401 }),
  );

  await assert.rejects(client.verify(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "credentials");
    assert.doesNotMatch(error.message, /never-print-this/);
    return true;
  });
});

test("Vikunja client distinguishes insufficient permissions", async () => {
  const client = createVikunjaClient("token", async () =>
    Response.json({ code: 3001, message: "Forbidden" }, { status: 403 }),
  );

  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "permission");
    return true;
  });
});
