import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

async function migrationSql(): Promise<string> {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = await readdir(directory);
  const name = files.find((file) => file.endsWith("_automata_mvp.sql"));
  assert.ok(name, "the Automata MVP migration must exist");
  return readFile(new URL(name, directory), "utf8");
}

async function allMigrationSql(): Promise<string> {
  const directory = new URL("../supabase/migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  return (await Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8")))).join("\n");
}

test("the MVP migration creates every workspace-scoped product table", async () => {
  const sql = await migrationSql();
  for (const table of [
    "workspaces",
    "workspace_members",
    "workspace_invitations",
    "workflows",
    "workflow_versions",
    "workflow_runs",
    "workflow_run_steps",
    "approvals",
    "connections",
    "usage_ledger",
    "notifications",
    "notification_preferences",
    "audit_logs",
    "beta_requests",
  ]) {
    assert.match(sql, new RegExp(`create table public\\.${table}\\b`, "i"), `${table} must exist`);
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, "i"), `${table} must use RLS`);
  }
});

test("authorization helpers are private and public tables receive explicit grants", async () => {
  const sql = await migrationSql();
  assert.match(sql, /create schema if not exists private/i);
  assert.match(sql, /create or replace function private\.has_workspace_role/i);
  assert.doesNotMatch(sql, /create or replace function public\.has_workspace_role/i);
  assert.match(sql, /grant select, insert, update, delete on public\.workflows to authenticated/i);
  assert.match(sql, /revoke all on public\.workspace_secrets from anon, authenticated/i);
});

test("run and billing idempotency are enforced by unique indexes", async () => {
  const sql = await migrationSql();
  assert.match(sql, /unique \(workflow_id, idempotency_key\)/i);
  assert.match(sql, /unique \(workspace_id, idempotency_key\)/i);
});

test("workspace ownership cannot be self-promoted or leave a workspace ownerless", async () => {
  const sql = await migrationSql();
  assert.match(sql, /create or replace function private\.protect_workspace_roles/i);
  assert.match(sql, /Workspace must retain at least one owner/i);
  assert.match(sql, /Only an owner can assign or remove the owner role/i);
});

test("workflow drafts store an optimistic revision and free-form canvas positions", async () => {
  const sql = await allMigrationSql();
  assert.match(sql, /draft_graph jsonb/i);
  assert.match(sql, /draft_positions jsonb/i);
  assert.match(sql, /draft_revision bigint/i);
});
