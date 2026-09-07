-- Shopify App Store installs, parked until a ZidaneAI account claims them.
--
-- WHY A TABLE AND NOT `workspace_provider_credentials`. That table is keyed by
-- workspace_id, and the whole problem this solves is an install that arrives
-- with NO workspace: a merchant who found ZidaneAI on the Shopify App Store
-- has approved our access before they have signed up for anything. The token
-- is real and must be kept, but there is nobody to attach it to yet, so the
-- shop domain is the primary key and workspace_id starts null.
--
-- Rows are claimed by /api/shopify/claim once a session exists, and deleted on
-- shop/redact (Shopify's mandatory erasure webhook) and on uninstall.
--
-- Same posture as workspace_provider_credentials: the token is encrypted by
-- src/lib/credentials.ts before it gets here, and RLS is ON with NO policy, so
-- PostgREST refuses this table for every ordinary session. Only the
-- service-role client can reach it. An unclaimed row has no owner to scope a
-- policy to, which is exactly why it must never be client-readable.
create table if not exists public.shopify_installs (
  shop text primary key,
  ciphertext text not null,
  scope text not null default '',
  workspace_id uuid references public.workspaces(id) on delete set null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The claim path looks a shop up by workspace to answer "is this store already
-- attached to someone?" before attaching it again.
create index if not exists shopify_installs_workspace_idx
  on public.shopify_installs (workspace_id);

alter table public.shopify_installs enable row level security;
