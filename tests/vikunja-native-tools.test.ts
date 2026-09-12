import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

const created: Array<{ projectId: number; title: string; description?: string }> = [];
mock.module("@/lib/integrations/vikunja-connection", {
  namedExports: {
    listVikunjaProjects: async () => [{ id: 21, title: "Operations" }],
    vikunjaClientFor: async () => ({
      createTask: async (projectId: number, task: { title: string; description?: string }) => {
        created.push({ projectId, ...task });
        return { id: 80 + created.length, ...task };
      },
      getTask: async (taskId: number) => ({ id: taskId, title: "Existing task" }),
      taskUrl: (taskId: number) => `https://vikunja.doubtbuddy.com/tasks/${taskId}`,
    }),
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
