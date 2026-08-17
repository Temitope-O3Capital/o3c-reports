-- Idempotency marker for "the assignee has been told they own this".
--
-- The Zoho sync is the source of all 35,035 tickets and contained ZERO Notify
-- calls, so a ticket that arrived from Zoho already assigned to an agent never
-- reached that agent. Adding the notification needs a guard, or every sync cycle
-- would re-announce the same ticket forever.
--
-- Stamped via a conditional UPDATE so only the caller that wins the race sends.
ALTER TABLE helpdesk_tickets
  ADD COLUMN IF NOT EXISTS assign_notified_at timestamptz;

-- Backfill: everything that exists TODAY is treated as already-announced.
-- Without this the first sync after deploy would notify eleven agents about
-- 28,521 historical tickets at once.
UPDATE helpdesk_tickets
   SET assign_notified_at = COALESCE(assigned_at, updated_at, created_at, NOW())
 WHERE assigned_to IS NOT NULL AND assign_notified_at IS NULL;

-- Drives the "who has not been told yet" lookup during sync.
CREATE INDEX IF NOT EXISTS idx_tickets_assign_unnotified
  ON helpdesk_tickets (assigned_to)
  WHERE assign_notified_at IS NULL AND assigned_to IS NOT NULL;
