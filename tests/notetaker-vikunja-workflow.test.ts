import { strict as assert } from "node:assert";
import { mock, test } from "node:test";
import { FakeDb } from "./helpers/fake-supabase";
import type { WorkflowGraph } from "@/lib/workflows/types";

/**
 * END-TO-END: meet.doubtbuddy.com's Notetaker webhook → AI meeting summary →
 * Vikunja tasks, driven through the REAL engine, claim, and idempotency code
 * (only the AI provider and the Vikunja account are mocked) against the
 * shipped `notetaker-vikunja-tasks` template.
 *
 * This is the test that would have caught the `resolveDeep` defect fixed
 * alongside this suite: before that fix, `items: "{{steps.extract_actions.actionItems}}"`
 * resolved to the ARRAY'S JSON TEXT, so `VIKUNJA_CREATE_TASKS` always failed
 * validation ("items must be an array…") and this template could never
 * create a single task. Every component test elsewhere in this suite mocks
 * its inputs as already-correct-shaped data and so could not see that the
 * pipe connecting two real nodes was broken.
 */

const db = new FakeDb();
const WORKSPACE = "ws-1";
const WORKFLOW = "wf-1";

let chatReply: (systemPrompt: string, turn: number) => string;
let chatTurn = 0;

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async (messages: { role: string; content: string }[]) => {
      chatTurn += 1;
      return chatReply(messages[0]?.content ?? "", chatTurn);
    },
    explainAiError: (err: unknown) => String(err),
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => null,
    brandContext: () => "",
    brandVideoHint: () => "",
  },
});

const created: Array<{ projectId: number; title: string; description?: string }> = [];
let createTaskImpl: (projectId: number, task: { title: string; description?: string }) => Promise<{ id: number; title: string; description?: string }> =
  async (projectId, task) => {
    created.push({ projectId, ...task });
    return { id: 900 + created.length, title: task.title, description: task.description };
  };

mock.module("@/lib/integrations/vikunja-connection", {
  namedExports: {
    listVikunjaProjects: async () => [{ id: 21, title: "Operations" }],
    vikunjaClientFor: async () => ({
      createTask: (projectId: number, task: { title: string; description?: string }) => createTaskImpl(projectId, task),
      getTask: async (taskId: number) => ({ id: taskId, title: "Existing task" }),
      taskUrl: (taskId: number) => `https://vikunja.doubtbuddy.com/tasks/${taskId}`,
    }),
  },
});

mock.module("@/lib/supabase/server", {
  namedExports: { createAdminClient: () => db, createClient: async () => db },
});

const { claimRun } = await import("@/lib/workflows/runtime");
const { getTemplate } = await import("@/lib/workflows/templates");

/** The shipped template with a real Vikunja project filled in — the builder
 *  leaves `project_id: ""` for the user to fill in during setup. */
function graphWithProject(projectId: number): WorkflowGraph {
  const template = getTemplate("notetaker-vikunja-tasks");
  assert.ok(template, "the notetaker-vikunja-tasks template must exist");
  const graph = JSON.parse(JSON.stringify(template.graph)) as WorkflowGraph;
  const create = graph.steps.create_tasks as unknown as { arguments: Record<string, unknown> };
  create.arguments.project_id = projectId;
  return graph;
}

function reset() {
  chatTurn = 0;
  created.length = 0;
  db.replace("workflow_runs", []);
  db.replace("credit_ledger", []);
  db.replace("workflows", []);
  db.seed("workflows", {
    id: WORKFLOW,
    workspace_id: WORKSPACE,
    active: true,
    config: { v: 1, graph: graphWithProject(21), display: { groups: [] } },
  });
  db.seed("credit_ledger", { workspace_id: WORKSPACE, delta: 100, reason: "signup_bonus" });
}

/** The default provider: two well-formed action items every time. */
function defaultChatReply(systemPrompt: string): string {
  if (systemPrompt.includes("action items as JSON")) {
    return JSON.stringify({
      items: [
        { title: "Send proposal", description: "Owner mentioned: Alex\nDeadline mentioned: Friday" },
        { title: "Book follow-up", description: "" },
      ],
    });
  }
  return "*Meeting summary*\n\n*Decisions*\nShip it.";
}

const PAYLOAD = {
  meeting_id: "meet-42",
  title: "Product sync",
  transcript: "Alex will send the proposal by Friday. Book a follow-up call.",
  event: "transcription.completed",
};

test("a completed Notetaker transcript becomes one Vikunja task per extracted action item", async () => {
  reset();
  chatReply = defaultChatReply;
  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;

  const claim = await claimRun({
    admin: db,
    workflowId: WORKFLOW,
    workspaceId: WORKSPACE,
    graph,
    input: PAYLOAD,
    idempotencyKey: "webhook:meet-42:transcription.completed",
    mode: "execute",
  });

  assert.equal(claim.status, "completed");
  const row = db.table("workflow_runs")[0]!;
  const log = row.log as {
    journal: Array<{ stepId: string; output: Record<string, unknown> }>;
    context: { steps: Record<string, { result?: Record<string, unknown> }> };
  };
  assert.deepEqual(
    log.journal.map((j) => j.stepId),
    ["meeting_complete", "extract_actions", "create_tasks"],
  );

  assert.equal(created.length, 2, "one Vikunja task per extracted action item");
  assert.equal(created[0]!.title, "Send proposal");
  assert.match(created[0]!.description ?? "", /Owner mentioned: Alex/);
  assert.match(created[0]!.description ?? "", /Meeting: Product sync/);
  assert.match(created[0]!.description ?? "", /Meeting ID: meet-42/);
  assert.equal(created[1]!.title, "Book follow-up");

  const createOutput = log.journal.find((j) => j.stepId === "create_tasks")!.output;
  const result = createOutput.result as { created_count: number; failed_count: number };
  assert.equal(result.created_count, 2);
  assert.equal(result.failed_count, 0);
});

test("replaying a finished run (the retried Notetaker delivery) creates zero additional tasks", async () => {
  reset();
  chatReply = defaultChatReply;
  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;
  const idempotencyKey = "webhook:meet-42:transcription.completed";

  const first = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD, idempotencyKey, mode: "execute",
  });
  assert.equal(first.status, "completed");
  assert.equal(created.length, 2);

  // meet.doubtbuddy.com retries the same delivery id after a slow 202.
  const second = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD, idempotencyKey, mode: "execute",
  });
  assert.equal(second.runId, first.runId, "the retry must reuse the original run");
  assert.equal(second.duplicate, true);
  assert.equal(created.length, 2, "no tasks were created twice");
  assert.equal(db.table("workflow_runs").length, 1);
});

test("meeting summary with no action items completes the run and writes zero Vikunja tasks", async () => {
  reset();
  chatReply = (systemPrompt) =>
    systemPrompt.includes("action items as JSON") ? JSON.stringify({ items: [] }) : "*Meeting summary*\nNothing actionable.";

  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;
  const claim = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph,
    input: { ...PAYLOAD, transcript: "We just caught up, nothing to follow up on." },
    idempotencyKey: "webhook:meet-quiet", mode: "execute",
  });

  assert.equal(claim.status, "completed");
  assert.equal(created.length, 0);
});

test("an invalid AI extraction fails the run at extract_actions, before any Vikunja write", async () => {
  reset();
  chatReply = (systemPrompt) =>
    systemPrompt.includes("action items as JSON") ? JSON.stringify({ notes: "no items key" }) : "summary text";

  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;
  const claim = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD,
    idempotencyKey: "webhook:meet-bad-ai", mode: "execute",
  });

  assert.equal(claim.status, "failed");
  const row = db.table("workflow_runs")[0]!;
  const log = row.log as { failed?: { stepId: string } };
  assert.equal(log.failed?.stepId, "extract_actions");
  assert.equal(created.length, 0, "nothing reaches Vikunja when extraction fails");
});

test("a Vikunja outage fails the run at create_tasks, and the completed extraction is not repeated on retry", async () => {
  reset();
  chatReply = defaultChatReply;
  let calls = 0;
  createTaskImpl = async () => {
    calls++;
    throw new Error("Vikunja could not be reached. Try again shortly.");
  };

  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;
  const claim = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD,
    idempotencyKey: "webhook:meet-vikunja-down", mode: "execute",
  });

  // The native tool aggregates per-item failures rather than throwing, so a
  // total outage on every item is reported as `created_count: 0` — the step
  // itself still "succeeds" and the run completes. This is the tool's actual
  // contract, documented here rather than assumed.
  assert.equal(claim.status, "completed");
  const row = db.table("workflow_runs")[0]!;
  const log = row.log as { journal: Array<{ stepId: string; output: Record<string, unknown> }> };
  const createOutput = log.journal.find((j) => j.stepId === "create_tasks")!.output;
  const result = createOutput.result as { created_count: number; failed_count: number };
  assert.equal(result.created_count, 0);
  assert.equal(result.failed_count, 2);
  assert.equal(calls, 2, "one attempt per action item, no retries on a write");

  // Restore for later tests in this file.
  createTaskImpl = async (projectId, task) => {
    created.push({ projectId, ...task });
    return { id: 900 + created.length, title: task.title, description: task.description };
  };
});

test("one bad Vikunja item does not block the meeting's other tasks", async () => {
  reset();
  chatReply = defaultChatReply;
  createTaskImpl = async (projectId, task) => {
    if (task.title === "Book follow-up") throw new Error("Vikunja returned HTTP 500.");
    created.push({ projectId, ...task });
    return { id: 900 + created.length, title: task.title, description: task.description };
  };

  const graph = (db.table("workflows")[0]!.config as { graph: WorkflowGraph }).graph;
  const claim = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD,
    idempotencyKey: "webhook:meet-partial", mode: "execute",
  });

  assert.equal(claim.status, "completed");
  assert.equal(created.length, 1);
  assert.equal(created[0]!.title, "Send proposal");
  const row = db.table("workflow_runs")[0]!;
  const log = row.log as { journal: Array<{ stepId: string; output: Record<string, unknown> }> };
  const createOutput = log.journal.find((j) => j.stepId === "create_tasks")!.output;
  const result = createOutput.result as { created_count: number; failed_count: number };
  assert.equal(result.created_count, 1);
  assert.equal(result.failed_count, 1);

  createTaskImpl = async (projectId, task) => {
    created.push({ projectId, ...task });
    return { id: 900 + created.length, title: task.title, description: task.description };
  };
});

test("a misconfigured extraction step (extract_action_items off) fails loudly at create_tasks rather than silently skipping it", async () => {
  reset();
  // `meeting_summary` only emits `actionItems` when `extract_action_items` is
  // on (see meeting-summary-unconfigured.test.ts for the OPENAI_API_KEY-off
  // case, which omits it the same way). `claimRun` runs `repairRefs` on every
  // graph before execution, and because "actionItems" is not a key this step
  // can statically produce with the flag off, it rewrites the dangling
  // `{{steps.extract_actions.actionItems}}` to the step's one real output,
  // `{{steps.extract_actions.text}}` — a STRING. `create_tasks` then fails at
  // Vikunja's own `Array.isArray(items)` guard rather than silently creating
  // zero tasks and looking like an empty meeting.
  const graph = graphWithProject(21);
  const misconfigured = graph.steps.extract_actions as unknown as { extract_action_items: boolean };
  misconfigured.extract_action_items = false;
  chatReply = () => "*Meeting summary*\nSummary only, no action items requested.";

  const claim = await claimRun({
    admin: db, workflowId: WORKFLOW, workspaceId: WORKSPACE, graph, input: PAYLOAD,
    idempotencyKey: "webhook:meet-no-extraction", mode: "execute",
  });

  assert.equal(claim.status, "failed", "create_tasks has nothing usable to read without actionItems");
  const row = db.table("workflow_runs")[0]!;
  const log = row.log as { failed?: { stepId: string; message: string } };
  assert.equal(log.failed?.stepId, "create_tasks");
  assert.match(String(log.failed?.message), /items must be an array/);
  assert.equal(created.length, 0);
});
