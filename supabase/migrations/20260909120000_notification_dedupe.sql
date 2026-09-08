-- Stop a re-driven run from notifying twice.
--
-- driveRun() emits a notification when a run fails or parks on an approval.
-- A run that fails, is reclaimed by reclaimStuckRuns, and fails again would
-- otherwise insert a second identical row — and, worse, send a second email.
-- The WhatsApp path has been protected all along by
-- message_deliveries.idempotency_key; this is the same idea for in-app rows.
--
-- Nullable, so every existing row is untouched and callers that have nothing
-- sensible to key on can simply omit it. The partial index means those NULLs
-- never collide with each other.

alter table public.notifications
  add column if not exists dedupe_key text;

create unique index if not exists notifications_dedupe_idx
  on public.notifications (user_id, dedupe_key)
  where dedupe_key is not null;
