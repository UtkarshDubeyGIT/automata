import { strict as assert } from "node:assert";
import { mock, test } from "node:test";

/**
 * What the AI node is actually told.
 *
 * Two real defects sit behind these: the node knew the instruction and the
 * upstream step outputs and nothing else, so "Write a LinkedIn post customized
 * to my business" came back as "Excited to share some updates from our
 * business!" for a workspace with a full brand profile saved; and because a
 * manual/schedule trigger contributes no data, every run of one workflow sent
 * a byte-identical prompt and four consecutive runs opened with the same
 * sentence. Both are properties of the PROMPT, so that is what is asserted.
 */

// `supabaseConfigured` is read at module load, and it gates the history read.
process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://localhost:54321";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "anon-key";

let sent: { role: string; content: string }[] = [];
let profile: unknown = null;

mock.module("@/lib/ai/openai", {
  namedExports: {
    openaiConfigured: true,
    chat: async (messages: { role: string; content: string }[]) => {
      sent = messages;
      return "a drafted post";
    },
    explainAiError: (err: unknown) => String(err),
  },
});

mock.module("@/lib/brand", {
  namedExports: {
    getBrandProfileForWorkspace: async () => profile,
    brandContext: (p: unknown) => (p ? "--- BRAND CONTEXT ---\nYou are writing for Acme." : ""),
    brandVideoHint: () => "",
  },
});

/** Enough of the query builder for `recentStepOutputs` to walk. */
function fakeDb(opts: { workflowId?: string | null; rows?: unknown[]; broken?: boolean }) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    order: () => chain,
    async maybeSingle() {
      if (opts.broken) throw new Error("database unreachable");
      return { data: opts.workflowId ? { workflow_id: opts.workflowId } : null };
    },
    async limit() {
      if (opts.broken) throw new Error("database unreachable");
      return { data: opts.rows ?? [] };
    },
  };
  return { from: () => chain };
}

let db = fakeDb({});
mock.module("@/lib/supabase/server", { namedExports: { createAdminClient: () => db } });

const { HANDLERS } = await import("@/lib/workflows/steps");
const { recentStepOutputs } = await import("@/lib/workflows/store");

async function draft(
  instruction = "Write a LinkedIn post customized to my business.",
  destination?: { platform: string | null; label: string; brief: string },
) {
  sent = [];
  const out = await HANDLERS.ai_step({
    runId: "run-now",
    stepId: "draft_post",
    step: { type: "ai_step", instruction },
    data: { steps: {} },
    entityId: "ws-1",
    reads: new Set<string>(),
    ...(destination ? { destination } : {}),
  } as never);
  return {
    out,
    system: sent.find((m) => m.role === "system")?.content ?? "",
    user: sent.find((m) => m.role === "user")?.content ?? "",
  };
}

test("the draft is grounded in the workspace's own business", async () => {
  profile = { company: "Acme" };
  db = fakeDb({});
  const { system } = await draft();
  assert.match(system, /You are writing for Acme\./);
});

test("a workspace with no brand profile still drafts, just generically", async () => {
  profile = null;
  db = fakeDb({});
  const { out, system } = await draft();
  assert.equal((out as { text: string }).text, "a drafted post");
  assert.doesNotMatch(system, /BRAND CONTEXT/);
});

test("the model is shown what it already published, so it stops repeating itself", async () => {
  profile = null;
  db = fakeDb({
    workflowId: "wf-1",
    rows: [
      { id: "r2", log: { journal: [{ stepId: "draft_post", output: { text: "Building an AI startup is a thrilling journey" } }] } },
      // json-mode steps carry the copy under `result`, not `text`.
      { id: "r1", log: { journal: [{ stepId: "draft_post", output: { result: { text: "An earlier post about hiring" } } }] } },
    ],
  });
  const { user } = await draft();
  assert.match(user, /Building an AI startup is a thrilling journey/);
  assert.match(user, /An earlier post about hiring/);
  assert.match(user, /materially different/);
});

test("a first run has no history section and says nothing about repeating", async () => {
  profile = null;
  db = fakeDb({ workflowId: "wf-1", rows: [] });
  const { user } = await draft();
  assert.doesNotMatch(user, /This automation has run before/);
});

test("history is best-effort — an unreadable log never fails the run", async () => {
  profile = null;
  db = fakeDb({ broken: true });
  const { out, user } = await draft();
  assert.equal((out as { text: string }).text, "a drafted post");
  assert.doesNotMatch(user, /This automation has run before/);
});

test("only this step's own previous outputs are quoted back", async () => {
  const found = await recentStepOutputs(
    fakeDb({
      workflowId: "wf-1",
      rows: [
        {
          id: "r1",
          log: {
            journal: [
              { stepId: "fetch_news", output: { text: "unrelated upstream data" } },
              { stepId: "draft_post", output: { text: "the post itself" } },
            ],
          },
        },
      ],
    }) as never,
    "run-now",
    "draft_post",
  );
  assert.deepEqual(found, ["the post itself"]);
});

test("the writer is told which channel this lands in, and how that channel reads", async () => {
  profile = { company: "Acme" };
  db = fakeDb({});
  const { system } = await draft("Write today's post.", {
    platform: "linkedin",
    label: "LinkedIn",
    brief: "No markdown, no headings, 3,000 characters maximum.",
  });
  // Without this the node wrote into the void and formatted for nobody — a
  // bolded title line and markdown headings, published to a real account.
  assert.match(system, /publishes this straight to LinkedIn/);
  assert.match(system, /No markdown, no headings/);
  // After the brand block: the brand's voice is authoritative, and this is
  // only the conventions of the room it is spoken in.
  assert.ok(
    system.indexOf("BRAND CONTEXT") < system.indexOf("WHERE THIS IS PUBLISHED"),
    "the channel's conventions must not be read as outranking the brand's voice",
  );
});

test("a draft with no known destination has no conventions invented for it", async () => {
  profile = null;
  db = fakeDb({});
  const { system } = await draft();
  assert.doesNotMatch(system, /WHERE THIS IS PUBLISHED/);
});
