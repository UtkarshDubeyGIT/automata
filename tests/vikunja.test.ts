import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  VikunjaError,
  createVikunjaClient,
  type VikunjaProject,
} from "@/lib/integrations/vikunja";

test("Vikunja client authenticates and lists writable projects", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createVikunjaClient("https://tasks.example.com/", "secret-token", async (input, init) => {
    calls.push({ url: String(input), init });
    return Response.json([
      { id: 21, title: "Operations", is_archived: false, max_permission: 1 },
      { id: 22, title: "Archive", is_archived: true, max_permission: 2 },
      { id: 23, title: "Read only", is_archived: false, max_permission: 0 },
    ] satisfies VikunjaProject[]);
  });

  const projects = await client.listProjects();

  assert.deepEqual(projects.map((project) => project.id), [21]);
  assert.equal(calls[0]?.url, "https://tasks.example.com/api/v1/projects?expand=permissions&per_page=100");
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer secret-token");
});

test("Vikunja client creates an unassigned task in the selected project", async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = createVikunjaClient("https://tasks.example.com", "token", async (input, init) => {
    request = { url: String(input), init };
    return Response.json({ id: 88, title: "Send proposal", description: "Owner mentioned: Alex" }, { status: 201 });
  });

  const task = await client.createTask(21, {
    title: "Send proposal",
    description: "Owner mentioned: Alex",
  });

  assert.equal(task.id, 88);
  assert.equal(request?.url, "https://tasks.example.com/api/v1/projects/21/tasks");
  assert.equal(request?.init?.method, "PUT");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    title: "Send proposal",
    description: "Owner mentioned: Alex",
  });
});

test("Vikunja client classifies rejected credentials without exposing the token", async () => {
  const client = createVikunjaClient("https://tasks.example.com", "never-print-this", async () =>
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
  const client = createVikunjaClient("https://tasks.example.com", "token", async () =>
    Response.json({ code: 3001, message: "Forbidden" }, { status: 403 }),
  );

  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "permission");
    return true;
  });
});

test("Vikunja requires a secure deployed app URL", () => {
  assert.throws(
    () => createVikunjaClient("http://tasks.example.com", "token"),
    /HTTPS Vikunja app URL/,
  );
  assert.throws(
    () => createVikunjaClient("https://user:pass@tasks.example.com", "token"),
    /HTTPS Vikunja app URL/,
  );
  assert.throws(
    () => createVikunjaClient("https://tasks.example.com/?x=1", "token"),
    /HTTPS Vikunja app URL/,
  );
  assert.throws(
    () => createVikunjaClient("https://tasks.example.com/#frag", "token"),
    /HTTPS Vikunja app URL/,
  );
  assert.throws(() => createVikunjaClient("not a url", "token"), /HTTPS Vikunja app URL/);
});

test("Vikunja preserves a sub-path instance and strips a trailing slash", async () => {
  const calls: string[] = [];
  const client = createVikunjaClient("https://tasks.example.com/vikunja/", "token", async (input) => {
    calls.push(String(input));
    return Response.json([]);
  });
  assert.equal(client.taskUrl(9), "https://tasks.example.com/vikunja/tasks/9");
  await client.listProjects();
  assert.equal(calls[0], "https://tasks.example.com/vikunja/api/v1/projects?expand=permissions&per_page=100");
});

test("createTask refuses an invalid project id before any network call", () => {
  // Not declared `async`, so an invalid argument throws synchronously rather
  // than rejecting the returned promise — every existing caller wraps the
  // call in try/catch (or `await` inside one), which catches either form, so
  // this is the client's real, if slightly inconsistent, contract.
  let called = false;
  const client = createVikunjaClient("https://tasks.example.com", "token", async () => {
    called = true;
    return Response.json({});
  });
  assert.throws(() => client.createTask(0, { title: "x" }), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "provider");
    return true;
  });
  assert.throws(() => client.createTask(-1, { title: "x" }));
  assert.throws(() => client.createTask(1.5, { title: "x" }));
  assert.equal(called, false, "an invalid project id must never reach Vikunja");
});

test("createTask refuses a blank title before any network call", () => {
  let called = false;
  const client = createVikunjaClient("https://tasks.example.com", "token", async () => {
    called = true;
    return Response.json({});
  });
  assert.throws(() => client.createTask(21, { title: "   " }), /title is required/);
  assert.equal(called, false);
});

test("createTask omits an empty description from the request body", async () => {
  let request: { init?: RequestInit } | undefined;
  const client = createVikunjaClient("https://tasks.example.com", "token", async (input, init) => {
    request = { init };
    return Response.json({ id: 1, title: "Send proposal" });
  });
  await client.createTask(21, { title: "Send proposal", description: "   " });
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { title: "Send proposal" });
});

test("a network failure is classified as a connection error, not surfaced raw", async () => {
  const client = createVikunjaClient("https://tasks.example.com", "token", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "connection");
    assert.doesNotMatch(error.message, /TypeError/);
    return true;
  });
});

test("a generic 5xx is classified as a provider error and surfaces the provider's message", async () => {
  const client = createVikunjaClient("https://tasks.example.com", "token", async () =>
    Response.json({ message: "Internal Server Error: disk full" }, { status: 500 }),
  );
  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "provider");
    assert.match(error.message, /disk full/);
    return true;
  });
});

test("a 5xx with an unparsable body falls back to a generic HTTP message", async () => {
  const client = createVikunjaClient("https://tasks.example.com", "token", async () =>
    new Response("<html>not json</html>", { status: 502, headers: { "content-type": "text/html" } }),
  );
  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.equal(error.kind, "provider");
    assert.equal(error.message, "Vikunja returned HTTP 502.");
    return true;
  });
});

test("the API token is redacted from a provider error message wherever it appears, not only on 401", async () => {
  const client = createVikunjaClient("https://tasks.example.com", "super-secret-token", async () =>
    Response.json({ message: "Rejected request signed with super-secret-token" }, { status: 500 }),
  );
  await assert.rejects(client.listProjects(), (error: unknown) => {
    assert.ok(error instanceof VikunjaError);
    assert.doesNotMatch(error.message, /super-secret-token/);
    assert.match(error.message, /\[redacted\]/);
    return true;
  });
});

test("an empty API token is refused before the client is even usable", () => {
  assert.throws(
    () => createVikunjaClient("https://tasks.example.com", "   "),
    (error: unknown) => {
      assert.ok(error instanceof VikunjaError);
      assert.equal(error.kind, "credentials");
      return true;
    },
  );
});
