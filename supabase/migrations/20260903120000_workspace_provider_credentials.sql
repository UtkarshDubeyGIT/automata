-- Workspace-owned provider secrets are encrypted before insertion. This table
-- intentionally has no client RLS policy: only the service-role credential
-- boundary may read or write ciphertext.
create table if not exists public.workspace_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null,
  ciphertext text not null,
  key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider)
);

alter table public.workspace_provider_credentials enable row level security;
