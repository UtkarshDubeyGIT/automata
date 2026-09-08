# Workflow runtime database compatibility

Automata retains its workspace membership and immutable version tables, and uses
Zidane's workflow graph, journal, credit ledger, and integration interfaces. The
compatibility migration adds the fields and tables those interfaces require.

`20260902080000_workflow_determinism.sql` includes the compatibility bootstrap
before its first ledger reference. This fixes fresh installs, whose migration
chain previously stopped at the missing `credit_ledger` table. The generated
`20260908145225_workflow_runtime_compatibility.sql` contains the same idempotent
bootstrap for existing Automata installations. Keep those two blocks synchronized.

Existing `draft_graph` and version graphs with either `{start, steps}` or
`{graph: {start, steps}}` are carried into the runtime configuration. Existing
runtime configurations are preserved. Unknown historical graph formats remain in
the original columns and version rows and are not automatically activated.

The migration preserves workspace membership policies and makes integration,
billing, and credit records readable by workspace members but writable only by
server workers. Workspace settings remain editable, while plan, balance, and
Stripe customer identifiers require the service role.

## Verify without a remote database

The smoke test runs every migration in an isolated PGlite database. Install that
optional test dependency outside the application:

```sh
npm install --prefix /tmp/automata-schema-check --no-save --package-lock=false @electric-sql/pglite@0.3.7
AUTOMATA_PGLITE_MODULE=/tmp/automata-schema-check/node_modules/@electric-sql/pglite/dist/index.js node scripts/verify-runtime-schema.mjs
```

It verifies migration ordering, preservation of old compatible drafts, signup,
opening credit grants, workflow inserts, timezone synchronization, atomic paid
build enqueue, worker run creation/completion, workspace isolation, and rejection
of browser credit and billing-identifier forgery.

The harness supplies minimal Supabase `auth` and `storage` schemas and roles.
PGlite already provides `gen_random_uuid`, so the harness omits only the
`CREATE EXTENSION pgcrypto` statement. This check does not exercise Supabase's
network services, real authentication, Storage uploads, or provider calls.

No remote migrations are applied by this command. The compatibility migration is
for the Automata workspace schema; it must not be run against an unrelated
Zidane/GrowthOS project whose migration history uses a different baseline.
