import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

const created: Array<{ projectId: number; title: string; description?: string }> = [];

/** Swappable per test: default behavior succeeds every create. */
let createTaskImpl = async (projectId: number, task: { title: string; description?: string }) => {
  created.push({ projectId, ...task });
  return { id: 80 + created.length, title: task.title, description: task.description };
};
/** Swappable per test: default resolves a working client; a test may reject instead
 *  (e.g. "no Vikunja connection for this workspace"). */
let vikunjaClientForImpl: () => Promise<{
  createTask: (projectId: number, task: { title: string; description?: string }) => Promise<{ id: number; title: string; description?: string }>;
  getTask: (taskId: number) => Promise<{ id: number; title: string }>;
  taskUrl: (taskId: number) => string;
}> = async () => ({
  createTask: (projectId, task) => createTaskImpl(projectId, task),
  getTask: async (taskId) => ({ id: taskId, title: "Existing task" }),
  taskUrl: (taskId) => `https://vikunja.doubtbuddy.com/tasks/${taskId}`,
});

mock.module("@/lib/integrations/vikunja-connection", {
  namedExports: {
    listVikunjaProjects: async () => [{ id: 21, title: "Operations" }],
    vikunjaClientFor: async () => vikunjaClientForImpl(),
  },
});
mock.module("@/lib/google/business-profile", {
  namedExports: {
    businessProfileConfigured: false,
    listReviews: async () => ({ reviews: [] }),
    replyToReview: async () => ({ error: "unused" }),
  },
});

const native = await import("@/lib/workflows/native-tools");
const registry = await import("@/lib/workflows/registry");

test("Vikunja is a real native workflow app with catalogued operations", () => {
  assert.equal(native.runsNatively("vikunja"), true);
  assert.equal(registry.TOOLS.VIKUNJA_LIST_PROJECTS.kind, "read");
  assert.equal(registry.TOOLS.VIKUNJA_CREATE_TASK.kind, "write");
  assert.equal(registry.TOOLS.VIKUNJA_GET_TASK.kind, "read");
  assert.equal(registry.APP_LABELS.vikunja, "Vikunja");
});

test("native Vikunja task creation returns a task link and does not assign anyone", async () => {
  created.length = 0;
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASK", "workspace-1", {
    project_id: 21,
    title: "Send proposal",
    description: "Meeting: Product sync\nOwner mentioned: Alex",
  });
  assert.equal(result?.successful, true);
  assert.ok(result?.data);
  assert.ok(result?.data);
  assert.deepEqual(created, [{ projectId: 21, title: "Send proposal", description: "Meeting: Product sync\nOwner mentioned: Alex" }]);
  assert.equal(result.data.task_url, "https://vikunja.doubtbuddy.com/tasks/81");
  assert.equal("assignees" in created[0]!, false);
});

test("native Vikunja project listing is readable by downstream steps", async () => {
  const result = await native.executeNativeTool("VIKUNJA_LIST_PROJECTS", "workspace-1", {});
  assert.equal(result?.successful, true);
  assert.ok(result?.data);
  assert.match(String(result.data.text), /Operations/);
});

test("native Vikunja batch creation makes one unassigned task per extracted item", async () => {
  created.length = 0;
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    meeting_title: "Product sync",
    meeting_id: "meet-3",
    items: [
      { title: "Send proposal", description: "Owner mentioned: Alex" },
      { title: "Book follow-up", description: "Deadline mentioned: Friday" },
    ],
  });
  assert.equal(result?.successful, true);
  assert.ok(result?.data);
  assert.equal(created.length, 2);
  assert.match(created[0]?.description ?? "", /Product sync/);
  assert.match(created[0]?.description ?? "", /meet-3/);
  assert.deepEqual((result.data.tasks as unknown[]).length, 2);
});

test("an empty action-item list completes without Vikunja writes", async () => {
  created.length = 0;
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items: [],
  });
  assert.equal(result?.successful, true);
  assert.ok(result?.data);
  assert.equal(created.length, 0);
  assert.deepEqual(result.data.tasks, []);
});

// ---------------------------------------------------------------------------
// Validation — every way project_id or items can arrive malformed
// ---------------------------------------------------------------------------

for (const projectId of ["", 0, -1, 1.5, "abc", undefined]) {
  test(`VIKUNJA_CREATE_TASKS rejects an invalid project_id: ${JSON.stringify(projectId)}`, async () => {
    created.length = 0;
    const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
      project_id: projectId,
      items: [{ title: "Send proposal" }],
    });
    assert.equal(result?.successful, false);
    assert.match(String(result?.error), /project_id is required/);
    assert.equal(created.length, 0, "nothing should reach Vikunja when validation fails first");
  });
}

test("VIKUNJA_CREATE_TASKS rejects items that are not an array — the resolveDeep regression surface", async () => {
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    // The exact failure mode if a template's `{{steps.x.actionItems}}` ever
    // resolved to its JSON string instead of a real array again.
    items: '[{"title":"Send proposal"}]',
  });
  assert.equal(result?.successful, false);
  assert.match(String(result?.error), /items must be an array/);
});

test("VIKUNJA_CREATE_TASKS rejects more than 50 items outright, creating nothing", async () => {
  created.length = 0;
  const items = Array.from({ length: 51 }, (_, i) => ({ title: `Item ${i}` }));
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items,
  });
  assert.equal(result?.successful, false);
  assert.match(String(result?.error), /at most 50/);
  assert.equal(created.length, 0);
});

test("VIKUNJA_CREATE_TASKS accepts exactly 50 items", async () => {
  created.length = 0;
  const items = Array.from({ length: 50 }, (_, i) => ({ title: `Item ${i}` }));
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items,
  });
  assert.equal(result?.successful, true);
  assert.equal(created.length, 50);
});

test("VIKUNJA_CREATE_TASKS accepts the projectId camelCase alias", async () => {
  created.length = 0;
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    projectId: 21,
    items: [{ title: "Send proposal" }],
  });
  assert.equal(result?.successful, true);
  assert.equal(created[0]?.projectId, 21);
});

// ---------------------------------------------------------------------------
// Malformed individual items — one bad item must not sink the whole batch
// ---------------------------------------------------------------------------

test("a non-object item and a blank-title item are reported as failed; valid items still create", async () => {
  created.length = 0;
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items: [
      { title: "Send proposal" },
      "not an object",
      { title: "   " },
      null,
      { title: "Book follow-up" },
    ],
  });
  assert.equal(result?.successful, true);
  assert.ok(result?.data);
  assert.equal(created.length, 2, "only the two valid items were written");
  assert.equal(result.data.created_count, 2);
  assert.equal(result.data.failed_count, 3);
  const failed = result.data.failed as Array<{ index: number; error: string }>;
  assert.deepEqual(failed.map((f) => f.index), [1, 2, 3]);
  assert.match(failed[0]!.error, /must be an object/);
  assert.match(failed[1]!.error, /missing a title/);
});

test("a single failing Vikunja write is isolated to that item; the rest of the batch still creates", async () => {
  created.length = 0;
  createTaskImpl = async (projectId, task) => {
    if (task.title === "Book follow-up") throw new Error("Vikunja returned HTTP 500.");
    created.push({ projectId, ...task });
    return { id: 80 + created.length, title: task.title, description: task.description };
  };
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items: [
      { title: "Send proposal" },
      { title: "Book follow-up" },
      { title: "File expenses" },
    ],
  });
  assert.equal(result?.successful, true, "a partial batch failure is not a step failure");
  assert.ok(result?.data);
  assert.equal(created.length, 2);
  assert.equal(result.data.created_count, 2);
  assert.equal(result.data.failed_count, 1);
  const failed = result.data.failed as Array<{ index: number; title: string; error: string }>;
  assert.deepEqual(failed, [{ index: 1, title: "Book follow-up", error: "Vikunja returned HTTP 500." }]);
  assert.match(String(result.data.text), /2 Vikunja task\(s\) created; 1 item\(s\) failed/);

  // Restore the default for subsequent tests.
  createTaskImpl = async (projectId, task) => {
    created.push({ projectId, ...task });
    return { id: 80 + created.length, title: task.title, description: task.description };
  };
});

test("no Vikunja connection for the workspace fails the whole tool, not per item", async () => {
  vikunjaClientForImpl = async () => {
    throw new Error("Vikunja is not connected for this workspace.");
  };
  const result = await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items: [{ title: "Send proposal" }],
  });
  assert.equal(result?.successful, false);
  assert.match(String(result?.error), /not connected/);

  vikunjaClientForImpl = async () => ({
    createTask: (projectId, task) => createTaskImpl(projectId, task),
    getTask: async (taskId) => ({ id: taskId, title: "Existing task" }),
    taskUrl: (taskId) => `https://vikunja.doubtbuddy.com/tasks/${taskId}`,
  });
});

// ---------------------------------------------------------------------------
// Description composition — the context line the meeting leaves on each task
// ---------------------------------------------------------------------------

test("task description carries the item's own text plus meeting context, in that order", async () => {
  created.length = 0;
  await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    meeting_title: "Product sync",
    meeting_id: "meet-3",
    items: [{ title: "Send proposal", description: "Owner mentioned: Alex" }],
  });
  assert.equal(
    created[0]?.description,
    "Owner mentioned: Alex\n\nMeeting: Product sync\nMeeting ID: meet-3",
  );
});

test("meeting context is omitted entirely when neither meeting_title nor meeting_id is given", async () => {
  created.length = 0;
  await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    items: [{ title: "Send proposal", description: "Owner mentioned: Alex" }],
  });
  assert.equal(created[0]?.description, "Owner mentioned: Alex");
});

test("meeting context alone (no item description) still becomes the task description", async () => {
  created.length = 0;
  await native.executeNativeTool("VIKUNJA_CREATE_TASKS", "workspace-1", {
    project_id: 21,
    meeting_id: "meet-3",
    items: [{ title: "Send proposal" }],
  });
  assert.equal(created[0]?.description, "Meeting ID: meet-3");
});
