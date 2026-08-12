-- 144: Turn on SLA + CSAT for the whole ticket dataset.
--
-- Findings that motivate this:
--   * Zoho carries NO SLA/priority/category data for this org (dueDate, category and
--     priority are null on every ticket), so the importer's "map SLA from Zoho
--     dueDate" was dead — sla_due_at was set on only ~344 of 34k tickets and CSAT
--     was never sent for Zoho tickets (csat_token was never generated).
--   * first_response_due was referenced by the create path but the column was never
--     actually added (manual ticket creation was failing on it).
--
-- Fix: compute SLA locally from each ticket's created_at + the active policy for its
-- priority (helpdesk_sla_policies), generate a CSAT token for every ticket, and
-- pre-set the monitor's "already alerted" flags so backfilling deadlines on 34k
-- historical tickets does NOT trigger a notification storm (the breach monitor only
-- notifies on tickets it transitions to breached).

-- 1. Columns the code expects but that were missing.
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS first_response_due TIMESTAMPTZ;
ALTER TABLE helpdesk_tickets ADD COLUMN IF NOT EXISTS sla_breached BOOLEAN DEFAULT FALSE;

-- 2. Backfill SLA deadlines from created_at + the priority's policy (default to the
--    'normal' policy's hours when a ticket's priority has no active policy row).
UPDATE helpdesk_tickets t SET
  sla_due_at = COALESCE(
    t.sla_due_at,
    t.created_at + make_interval(hours => COALESCE(
      (SELECT resolution_hours FROM helpdesk_sla_policies
        WHERE priority = COALESCE(NULLIF(t.priority,''),'normal') AND is_active LIMIT 1), 24))),
  first_response_due = COALESCE(
    t.first_response_due,
    t.created_at + make_interval(hours => COALESCE(
      (SELECT first_response_hours FROM helpdesk_sla_policies
        WHERE priority = COALESCE(NULLIF(t.priority,''),'normal') AND is_active LIMIT 1), 8)))
WHERE t.sla_due_at IS NULL OR t.first_response_due IS NULL;

-- 3. Give every ticket a CSAT token so resolving a Zoho ticket can send the survey.
UPDATE helpdesk_tickets
SET csat_token = gen_random_uuid()::text
WHERE csat_token IS NULL OR csat_token = '';

-- 4. Suppress retro-alerts. Set the persisted breach flag to reflect reality (past
--    due + still open = breached) so readers/CBN are accurate, and mark warning /
--    unassigned alerts as already sent on every existing ticket so the 60s monitor
--    doesn't fan out thousands of notifications for this historical backfill. New
--    tickets created after this migration get the normal FALSE defaults and alert
--    at the right time.
UPDATE helpdesk_tickets SET
  sla_breached          = (sla_due_at IS NOT NULL AND sla_due_at < NOW() AND status NOT IN ('resolved','closed')),
  sla_warning_sent      = TRUE,
  unassigned_alert_sent = TRUE;
