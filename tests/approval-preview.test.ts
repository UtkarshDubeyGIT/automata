import { strict as assert } from "node:assert";
import { test } from "node:test";

/**
 * "What am I approving?"
 *
 * A `human_approval` step reached the screen as its own prompt and nothing
 * else, so every approval in the product read "Approve this before it goes
 * out?" over two buttons — while the post it was about was already written,
 * the picture already generated, and the account already named, all one hop
 * further along the graph. These pin the answer: the preview must carry the
 * RESOLVED content of what runs next, never a template, and never a promise
 * about a path the data has not chosen yet.
 *
 * No provider keys: with none set every step simulates, which is what lets a
 * run be driven all the way to its pause in-process.
 */
delete process.env.OPENAI_API_KEY;
delete process.env.COMPOSIO_API_KEY;

import type { RunLog, RunStatus, WorkflowGraph } from "@/lib/workflows/types";
import type { RunStore } from "@/lib/workflows/engine";

const { startRun } = await import("@/lib/workflows/engine");
const { buildApprovalPreview, pendingPreview } = await import("@/lib/workflows/preview");

function fakeStore(): RunStore & { runs: Map<string, { status: RunStatus; log: RunLog }> } {
  const runs = new Map<string, { status: RunStatus; log: RunLog }>();
  let n = 0;
  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
  return {
    runs,
    async createRun(_workflowId, log) {
      const id = `run-${++n}`;
      runs.set(id, { status: "running", log: clone(log) });
      return id;
    },
    async loadRun(runId) {
      const r = runs.get(runId);
      return r ? { id: runId, status: r.status, log: clone(r.log) } : null;
    },
    async saveRun(runId, patch) {
      const r = runs.get(runId);
      if (!r) throw new Error(`no such run ${runId}`);
      r.log = clone(patch.log);
      if (patch.status) r.status = patch.status;
    },
  };
}

/** Draft a post, pause for a person, then publish it with a picture. */
const postAfterApproval = {
  start: "trigger",
  steps: {
    trigger: { type: "manual_trigger_input", next: "draft" },
    draft: { type: "ai_step", title: "Write the post", instruction: "write a founder post", next: "review" },
    review: {
      type: "human_approval",
      title: "Review",
      prompt: "Approve this before it goes out?",
      on_approve: "publish",
      on_reject: "note",
    },
    publish: {
      type: "social_post",
      platform: "linkedin",
      text: "{{steps.draft.text}}",
      mediaUrl: "https://cdn.example.com/hero.png",
      next: null,
    },
    note: { type: "log_action", title: "Log the rejection", label: "skipped", message: "Rejected", next: null },
  },
} as unknown as WorkflowGraph;

test("a run that pauses for approval records WHAT is being approved, not just the question", async () => {
  const store = fakeStore();
  const result = await startRun(store, {
    workflowId: "wf",
    graph: postAfterApproval,
    entityId: "ws",
  });

  assert.equal(result.status, "waiting");
  const pending = store.runs.get(result.runId)!.log.pending!;
  assert.equal(pending.prompt, "Approve this before it goes out?");

  const preview = pending.preview!;
  assert.ok(preview, "the pause carries a preview");
  const [action] = preview.actions;
  // The destination, in the words a person uses for it.
  assert.match(action.label, /LinkedIn/);
  assert.equal(action.app, "linkedin");
  // The post itself — resolved from the draft step, not the template.
  assert.equal(action.body, "[preview output for: write a founder post]");
  assert.doesNotMatch(String(action.body), /\{\{/);
  assert.equal(action.imageUrl, "https://cdn.example.com/hero.png");
});

test("the preview says what approving does and what rejecting does instead", async () => {
  const store = fakeStore();
  const result = await startRun(store, {
    workflowId: "wf",
    graph: postAfterApproval,
    entityId: "ws",
  });
  const preview = store.runs.get(result.runId)!.log.pending!.preview!;
  assert.match(preview.summary, /publish to LinkedIn/i);
  // The rejection path is a step with a title, so it is named rather than
  // described as "the run stops" — which would be false here.
  assert.match(preview.onReject, /Log the rejection/);
  // Drafted with no AI key, so approving it could only ever be refused.
  assert.equal(preview.simulated, true);
});

test("a draft that has not been written yet is said in words, never as {{steps.x.y}}", () => {
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "write", on_reject: null },
      write: { type: "ai_step", instruction: "draft it", next: "publish" },
      publish: { type: "social_post", platform: "x", text: "{{steps.write.text}}", next: null },
    },
  } as unknown as WorkflowGraph;

  const preview = buildApprovalPreview(graph, "review", { v: 1, journal: [], context: { steps: {} } })!;
  const publish = preview.actions.find((a) => a.stepId === "publish")!;
  assert.equal(publish.unresolved, true);
  assert.equal(publish.body, undefined, "no braces are shown as if they were the post");
  assert.match(preview.onReject, /stops here/);
});

test("the destination's own settings — a Slack channel, a subreddit — are shown beside the message", () => {
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "publish", on_reject: null },
      publish: {
        type: "social_post",
        platform: "slack",
        text: "This week: 12 new customers.",
        options: { channel: "#growth" },
        next: null,
      },
    },
  } as unknown as WorkflowGraph;

  const preview = buildApprovalPreview(graph, "review", { v: 1, journal: [], context: { steps: {} } })!;
  const [action] = preview.actions;
  assert.equal(action.body, "This week: 12 new customers.");
  assert.deepEqual(action.fields, [{ label: "Channel", value: "#growth" }]);
});

test("an email's body is the preview and its recipient and subject sit beside it", () => {
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "send", on_reject: null },
      send: {
        type: "app_action",
        tool: "GMAIL_SEND_EMAIL",
        arguments: {
          recipient_email: "chris@example.com",
          subject: "Your weekly numbers",
          body: "Here is how the week went.",
        },
        next: null,
      },
    },
  } as unknown as WorkflowGraph;

  const preview = buildApprovalPreview(graph, "review", { v: 1, journal: [], context: { steps: {} } })!;
  const [action] = preview.actions;
  assert.equal(action.body, "Here is how the week went.");
  assert.equal(action.app, "gmail");
  assert.deepEqual(
    action.fields.map((f) => f.label),
    ["Recipient email", "Subject"],
  );
});

/**
 * The shipped "classify, then decide, then post to one of three places" shape.
 * Which branch it takes is decided by data this run has not produced, so the
 * preview must not pick one — but the draft it is holding is still readable,
 * and that is the thing actually being judged.
 */
test("an approval in front of a branch shows the draft and admits what happens next depends", () => {
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "route", on_reject: null },
      route: { type: "branch", branch_on: "sentiment", cases: { positive: "praise" }, default: null },
      praise: { type: "social_post", platform: "linkedin", text: "Thank you!", next: null },
    },
  } as unknown as WorkflowGraph;
  const log: RunLog = {
    v: 1,
    journal: [
      {
        stepId: "draft",
        type: "ai_step",
        title: "Write the reply",
        status: "done",
        output: { text: "Thanks so much for the kind words." },
        at: "2026-08-29T10:00:00.000Z",
      },
    ],
    context: { steps: { draft: { text: "Thanks so much for the kind words." } } },
  };

  const preview = buildApprovalPreview(graph, "review", log)!;
  assert.equal(preview.conditional, true);
  assert.equal(preview.actions.length, 0, "no branch is promised");
  assert.deepEqual(
    preview.drafts.map((d) => d.text),
    ["Thanks so much for the kind words."],
  );
});

test("a run that was already waiting before previews existed still gets one on read", () => {
  const log: RunLog = {
    v: 1,
    journal: [],
    context: { steps: { draft: { text: "An announcement." } } },
    // No `preview` key — exactly what an older waiting row looks like.
    pending: { token: "run:review", stepId: "review", prompt: "Approve?" },
  };
  const graph = {
    start: "review",
    steps: {
      review: { type: "human_approval", on_approve: "publish", on_reject: null },
      publish: { type: "social_post", platform: "linkedin", text: "{{steps.draft.text}}", next: null },
    },
  } as unknown as WorkflowGraph;

  const derived = pendingPreview(log, graph)!;
  assert.equal(derived.actions[0].body, "An announcement.");

  // And when the engine did record one, that snapshot wins — a workflow edited
  // while a run waits must not change what the card says was up for approval.
  const snapshotted: RunLog = {
    ...log,
    pending: {
      ...log.pending!,
      preview: { summary: "Recorded earlier.", actions: [], drafts: [], onReject: "Stops." },
    },
  };
  assert.equal(pendingPreview(snapshotted, graph)!.summary, "Recorded earlier.");
});

test("a decided approval no longer advertises a decision", async () => {
  const store = fakeStore();
  const started = await startRun(store, {
    workflowId: "wf",
    graph: postAfterApproval,
    entityId: "ws",
  });
  const log = store.runs.get(started.runId)!.log;
  assert.ok(log.pending?.preview, "it is there while the run waits");

  // Record the rejection the way the decision route does, then let the engine
  // replay: `pending` (preview and all) is cleared when the step completes.
  log.context.decisions = { review: { decision: "reject", at: "2026-08-29T10:00:00.000Z" } };
  store.runs.get(started.runId)!.log = log;
  const { resumeRun } = await import("@/lib/workflows/engine");
  const finished = await resumeRun(store, postAfterApproval, started.runId, "ws");

  assert.equal(finished.status, "completed");
  assert.equal(store.runs.get(started.runId)!.log.pending, undefined);
});
