import test from "node:test";
import assert from "node:assert/strict";

import { notifyWorkspace } from "@/lib/notifications/service";

/**
 * A stand-in for the service-role client, recording every insert.
 *
 * Built by hand rather than reused from ./helpers/fake-supabase because these
 * tests care about a very specific thing: exactly which rows were written and
 * whether `auth.admin` was reachable at all.
 */
function makeAdmin(options: {
  members?: string[];
  preference?: Record<string, unknown> | null;
  seenDedupeKeys?: string[];
  /** Omit `auth` entirely to mimic the minimal fakes the run tests inject. */
  withAuth?: boolean;
} = {}) {
  const {
    members = ["user-1"],
    preference = null,
    seenDedupeKeys = [],
    withAuth = true,
  } = options;

  const inserted: Record<string, unknown>[] = [];

  function from(table: string) {
    if (table === "workspace_members") {
      return {
        select: () => ({
          eq: async () => ({ data: members.map((user_id) => ({ user_id })) }),
        }),
      };
    }
    if (table === "notification_preferences") {
      return {
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: preference }) }) }),
        }),
      };
    }
    // notifications: a dedupe lookup and an insert.
    return {
      select: () => ({
        eq: () => ({
          eq: (_column: string, value: string) => ({
            maybeSingle: async () => ({
              data: seenDedupeKeys.includes(value) ? { id: "existing" } : null,
            }),
          }),
        }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserted.push(row);
        return { error: null };
      },
    };
  }

  const admin: Record<string, unknown> = { from };
  if (withAuth) {
    admin.auth = {
      admin: {
        getUserById: async () => ({ data: { user: { email: "member@example.com" } } }),
      },
    };
  }
  return { admin, inserted };
}

/** Resend is only reachable when both env vars are set; keep them unset. */
function withoutEmailEnv<T>(run: () => T): T {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  delete process.env.RESEND_API_KEY;
  delete process.env.EMAIL_FROM;
  try {
    return run();
  } finally {
    if (key !== undefined) process.env.RESEND_API_KEY = key;
    if (from !== undefined) process.env.EMAIL_FROM = from;
  }
}

const NOTICE = {
  workspaceId: "ws-1",
  kind: "failure" as const,
  title: "A workflow run failed",
  body: "Boom.",
  href: "/app/workflows/wf-1?run=run-1",
};

test("a notification is recorded for every workspace member", async () => {
  const { admin, inserted } = makeAdmin({ members: ["user-1", "user-2"] });

  await withoutEmailEnv(() => notifyWorkspace(admin as never, NOTICE));

  assert.equal(inserted.length, 2);
  assert.deepEqual(inserted.map((row) => row.user_id), ["user-1", "user-2"]);
  // The href is what makes the bell land on the run rather than a list.
  assert.equal(inserted[0].href, "/app/workflows/wf-1?run=run-1");
});

test("a repeat of the same dedupe key notifies nobody a second time", async () => {
  // The case this exists for: a run fails, reclaimStuckRuns re-drives it, and
  // it fails again. One incident must not produce two rows or two emails.
  const { admin, inserted } = makeAdmin({ seenDedupeKeys: ["workflow-failure:run-1"] });

  await withoutEmailEnv(() =>
    notifyWorkspace(admin as never, { ...NOTICE, dedupeKey: "workflow-failure:run-1" }),
  );

  assert.deepEqual(inserted, []);
});

test("an unseen dedupe key is stored so the next attempt can match it", async () => {
  const { admin, inserted } = makeAdmin();

  await withoutEmailEnv(() =>
    notifyWorkspace(admin as never, { ...NOTICE, dedupeKey: "workflow-failure:run-9" }),
  );

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].dedupe_key, "workflow-failure:run-9");
});

test("a kind the user switched off is skipped entirely", async () => {
  const { admin, inserted } = makeAdmin({
    preference: { in_app: true, email: true, events: { failure: false } },
  });

  await withoutEmailEnv(() => notifyWorkspace(admin as never, NOTICE));

  assert.deepEqual(inserted, []);
});

test("turning off in-app delivery stops the row being written", async () => {
  const { admin, inserted } = makeAdmin({
    preference: { in_app: false, email: true, events: {} },
  });

  await withoutEmailEnv(() => notifyWorkspace(admin as never, NOTICE));

  assert.deepEqual(inserted, []);
});

test("email is skipped for kinds that opt out of it", async () => {
  // Approvals are in-app only: they already reach people over WhatsApp, and
  // mailing every member on every gate turns a workflow into a mailing list.
  const { admin, inserted } = makeAdmin();

  await withoutEmailEnv(() =>
    notifyWorkspace(admin as never, { ...NOTICE, kind: "approval", email: false }),
  );

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].email_status, "skipped");
});

test("an admin client with no auth API still records the notification", async () => {
  // driveRun is typed against DbClient and the run tests inject a fake with no
  // `.auth`. Losing the email address must never cost us the in-app row, and
  // must never throw into the run that triggered it.
  const { admin, inserted } = makeAdmin({ withAuth: false });

  await notifyWorkspace(admin as never, NOTICE);

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].email_status, "skipped");
});
