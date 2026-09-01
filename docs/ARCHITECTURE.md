# Architecture

## Boundary

Automata owns identity, workspaces, workflow graphs and immutable versions, scheduling, execution, approvals, journals, usage, notifications, and billing. Composio owns third-party authorization and tool execution. Supabase owns Postgres and Auth. OpenAI supplies text and synchronous image modules. Stripe owns subscription payment state.

## Execution lifecycle

`manual | webhook | schedule | app event → immutable workflow version → module executor → journal + usage ledger → approval pause or terminal result`

All trigger paths call the same executor. “Run once” is not a simulation. External provider errors stop the run and charge zero for the failed module. The API never retries an uncertain external write. Every run and ledger debit has a stable idempotency key.

Approvals persist the executor context and next edge. An owner, admin, or member can approve or reject; a viewer cannot. Resumption uses the same immutable version and recorded output, so later edits cannot change an in-flight run.

## Security model

- Workspace scope is present on every product record and enforced with RLS.
- Browser roles cannot insert run, journal, ledger, billing-event, or secret rows.
- Server endpoints authenticate the user, verify their workspace role, then use the secret-key client only for internal mutations.
- HTTP modules resolve DNS and reject local/private destinations and redirects.
- Logs redact credential-shaped keys, bound depth/size, and never expose Composio or platform keys.
- AI-generated workflows cannot emit code or destructive/financial modules; safety defaults insert approvals before external writes.

## Deployment

The Next.js web process can run on Vercel or any Node 22 host. On Vercel, cron invokes a bounded schedule sweep. On a VM, the companion worker polls due workflows and uses compare-and-set claims, so multiple workers do not execute the same scheduled occurrence.
