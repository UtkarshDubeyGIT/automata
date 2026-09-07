import { randomUUID } from "node:crypto";

/**
 * An in-memory stand-in for the PostgREST client, good enough for the claim
 * path: inserts, filtered selects, conditional updates, and — the part that
 * actually matters — UNIQUE INDEXES.
 *
 * The exactly-once guarantee is not in the application code; it is in the
 * database rejecting the second insert. A fake that accepts everything would
 * let every one of these tests pass while production doubled every trigger,
 * so `23505` is modelled first and everything else exists to support it.
 */

export interface PgError {
  code: string;
  message: string;
}

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

/** The unique indexes migration 0018 creates, as (table → column tuples). */
const UNIQUE: Record<string, string[][]> = {
  workflows: [["workspace_id", "creation_key"]],
  workflow_runs: [["workflow_id", "idempotency_key"]],
  workflow_builds: [["workspace_id", "request_key"]],
  credit_ledger: [["workspace_id", "idem_key"]],
  job_locks: [["name"]],
  message_deliveries: [["idempotency_key"], ["twilio_message_sid"]],
};

function violates(table: string, rows: Row[], candidate: Row): boolean {
  for (const columns of UNIQUE[table] ?? []) {
    // Partial indexes: a NULL in any column means the row is not indexed.
    if (columns.some((c) => candidate[c] == null)) continue;
    if (rows.some((r) => columns.every((c) => r[c] === candidate[c]))) return true;
  }
  return false;
}

const DUPLICATE: PgError = {
  code: "23505",
  message: "duplicate key value violates unique constraint",
};

/**
 * PostgREST's `or=` grammar, limited to what this codebase writes:
 *   status.eq.queued,and(status.eq.running,claimed_at.lt.<iso>)
 */
/**
 * PostgREST json path filters — `trigger_state->realtime->>instanceId`.
 *
 * `->` walks into the jsonb, `->>` walks in and returns the value as TEXT.
 * `eq` used to do a flat `row[column]` lookup, so a filter like that matched a
 * property literally named "trigger_state->realtime->>instanceId", found
 * nothing, and quietly returned no rows. The inbound Composio webhook route
 * locates a workflow by exactly this filter, which meant any test of it would
 * have agreed with whatever the route did while proving nothing.
 */
function jsonPath(column: string): (row: Row) => unknown {
  if (!column.includes("->")) return (row) => row[column];
  const [head, ...rest] = column.split(/->>?/);
  // `->>` is always the final operator in PostgREST, and it is what turns the
  // extracted value into text — which is why the comparison below is a string.
  const asText = column.includes("->>");
  return (row) => {
    let value: unknown = row[head];
    for (const key of rest) {
      if (value == null || typeof value !== "object") return undefined;
      value = (value as Record<string, unknown>)[key];
    }
    return asText && value != null ? String(value) : value;
  };
}

function parseOr(expression: string): Predicate {
  const terms = splitTop(expression);
  const predicates = terms.map((term) => {
    const grouped = term.match(/^and\(([\s\S]*)\)$/);
    if (grouped) {
      const inner = splitTop(grouped[1]).map(parseComparison);
      return (row: Row) => inner.every((p) => p(row));
    }
    return parseComparison(term);
  });
  return (row) => predicates.some((p) => p(row));
}

/** Split on commas that are not inside parentheses. */
function splitTop(expression: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of expression) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

function parseComparison(term: string): Predicate {
  const [column, op, ...rest] = term.split(".");
  const value = rest.join(".");
  switch (op) {
    case "eq":
      return (row) => String(row[column]) === value;
    case "lt":
      return (row) => row[column] != null && String(row[column]) < value;
    case "gt":
      return (row) => row[column] != null && String(row[column]) > value;
    case "is":
      return (row) => (value === "null" ? row[column] == null : row[column] != null);
    default:
      throw new Error(`fake-supabase: unsupported operator '${op}' in '${term}'`);
  }
}

class Query implements PromiseLike<{ data: unknown; error: PgError | null }> {
  private readonly db: FakeDb;
  private readonly table: string;
  private readonly op: "select" | "insert" | "update" | "delete" | "upsert";
  private readonly payload: Row | Row[] | undefined;
  /**
   * `onConflict` columns and whether a clash keeps the existing row.
   *
   * Real PostgREST resolves the conflict against a unique index; here the
   * caller names the columns, which is the same information and avoids the fake
   * having to know every index in the schema. `ignoreDuplicates: true` is
   * `ON CONFLICT DO NOTHING` — the ORIGINAL row survives, which is the whole
   * reason production code passes it (a lead who has since replied must not be
   * reset to `new` by a second lead search finding them again).
   */
  private readonly conflict: { columns: string[]; ignoreDuplicates: boolean } | null = null;
  private predicates: Predicate[] = [];
  private sort: { column: string; ascending: boolean } | null = null;
  private max: number | null = null;
  private shape: "many" | "single" | "maybe" = "many";

  constructor(
    db: FakeDb,
    table: string,
    op: "select" | "insert" | "update" | "delete" | "upsert",
    payload?: Row | Row[],
    conflict?: { columns: string[]; ignoreDuplicates: boolean } | null,
  ) {
    this.db = db;
    this.table = table;
    this.op = op;
    this.payload = payload;
    this.conflict = conflict ?? null;
  }

  eq(column: string, value: unknown) {
    const read = jsonPath(column);
    this.predicates.push((row) => read(row) === value);
    return this;
  }
  neq(column: string, value: unknown) {
    this.predicates.push((row) => row[column] !== value);
    return this;
  }
  lt(column: string, value: string) {
    this.predicates.push((row) => row[column] != null && String(row[column]) < value);
    return this;
  }
  is(column: string, value: null | boolean) {
    this.predicates.push((row) => (value === null ? row[column] == null : row[column] === value));
    return this;
  }
  not(column: string, operator: "is", value: null | boolean) {
    if (operator !== "is") throw new Error(`Unsupported not operator: ${operator}`);
    this.predicates.push((row) => (value === null ? row[column] != null : row[column] !== value));
    return this;
  }
  in(column: string, values: unknown[]) {
    this.predicates.push((row) => values.includes(row[column]));
    return this;
  }
  or(expression: string) {
    this.predicates.push(parseOr(expression));
    return this;
  }
  order(column: string, opts?: { ascending?: boolean }) {
    this.sort = { column, ascending: opts?.ascending !== false };
    return this;
  }
  limit(n: number) {
    this.max = n;
    return this;
  }
  select() {
    return this;
  }
  single() {
    this.shape = "single";
    return this;
  }
  maybeSingle() {
    this.shape = "maybe";
    return this;
  }

  private matching(): Row[] {
    const rows = this.db.table(this.table).filter((row) => this.predicates.every((p) => p(row)));
    if (this.sort) {
      const { column, ascending } = this.sort;
      rows.sort((a, b) => {
        const left = String(a[column] ?? "");
        const right = String(b[column] ?? "");
        return ascending ? left.localeCompare(right) : right.localeCompare(left);
      });
    }
    return this.max == null ? rows : rows.slice(0, this.max);
  }

  private run(): { data: unknown; error: PgError | null } {
    const rows = this.db.table(this.table);
    let affected: Row[] = [];

    if (this.op === "insert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      for (const row of incoming) {
        const withDefaults: Row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          started_at: new Date().toISOString(),
          ...row,
        };
        if (violates(this.table, rows, withDefaults)) {
          return { data: null, error: DUPLICATE };
        }
        rows.push(withDefaults);
        affected.push(withDefaults);
      }
    } else if (this.op === "upsert") {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload ?? {}];
      const keys = this.conflict?.columns ?? ["id"];
      for (const row of incoming) {
        // Postgres unique indexes on these tables are case-folded on text
        // (leads is `lower(email)`), and a conflict key that matched
        // case-sensitively here would let the fake accept a duplicate the real
        // database rejects — the exact class of lie this helper exists to avoid.
        const same = (a: unknown, b: unknown) =>
          typeof a === "string" && typeof b === "string"
            ? a.toLowerCase() === b.toLowerCase()
            : a === b;
        const existing = rows.find((r) => keys.every((k) => same(r[k], row[k])));
        if (existing) {
          // DO NOTHING keeps the original and reports nothing written, which is
          // what `.select()` after an ignoreDuplicates upsert returns for real.
          if (!this.conflict?.ignoreDuplicates) {
            Object.assign(existing, row);
            affected.push(existing);
          }
          continue;
        }
        const withDefaults: Row = {
          id: randomUUID(),
          created_at: new Date().toISOString(),
          ...row,
        };
        if (violates(this.table, rows, withDefaults)) {
          return { data: null, error: DUPLICATE };
        }
        rows.push(withDefaults);
        affected.push(withDefaults);
      }
    } else if (this.op === "update") {
      affected = this.matching();
      for (const row of affected) Object.assign(row, this.payload as Row);
    } else if (this.op === "delete") {
      affected = this.matching();
      this.db.replace(
        this.table,
        rows.filter((r) => !affected.includes(r)),
      );
    } else {
      affected = this.matching();
    }

    const data = affected.map((r) => ({ ...r }));
    if (this.shape === "single") {
      return data.length === 1
        ? { data: data[0], error: null }
        : { data: null, error: { code: "PGRST116", message: "expected exactly one row" } };
    }
    if (this.shape === "maybe") {
      return { data: data[0] ?? null, error: null };
    }
    return { data, error: null };
  }

  then<R1 = { data: unknown; error: PgError | null }, R2 = never>(
    onfulfilled?: ((value: { data: unknown; error: PgError | null }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    try {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    } catch (err) {
      return Promise.reject(err).then(onfulfilled, onrejected);
    }
  }
}

export class FakeDb {
  private readonly tables = new Map<string, Row[]>();

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  replace(name: string, rows: Row[]) {
    this.tables.set(name, rows);
  }

  /** Seed rows directly, bypassing the constraint checks. */
  seed(name: string, ...rows: Row[]) {
    this.table(name).push(...rows);
  }

  from(name: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    return {
      select: () => new Query(db, name, "select"),
      insert: (payload: Row | Row[]) => new Query(db, name, "insert", payload),
      upsert: (
        payload: Row | Row[],
        options?: { onConflict?: string; ignoreDuplicates?: boolean },
      ) =>
        new Query(db, name, "upsert", payload, {
          columns: (options?.onConflict ?? "id").split(",").map((c) => c.trim()),
          ignoreDuplicates: options?.ignoreDuplicates ?? false,
        }),
      update: (payload: Row) => new Query(db, name, "update", payload),
      delete: () => new Query(db, name, "delete"),
    };
  }
}
