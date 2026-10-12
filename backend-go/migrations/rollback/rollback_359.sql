-- Rollback for 359_a_satisfaction_survey_records_that_it_was_sent.sql
--
-- Dropping csat_sent_at loses the record of WHO HAS ALREADY BEEN ASKED. If the batch
-- sender is still in place when this runs, the next pass re-asks every recently resolved
-- customer, because the column it checks no longer exists — and a customer receiving the
-- same survey twice is worse than never receiving it.
--
-- So: remove the sender first (handlers/batch.go, the CSAT step), or keep a copy:
--
--   CREATE TABLE app.csat_sent_backup_359 AS
--     SELECT id, csat_sent_at FROM app.helpdesk_tickets WHERE csat_sent_at IS NOT NULL;

BEGIN;

DROP INDEX IF EXISTS app.helpdesk_tickets_csat_unsent_idx;
ALTER TABLE app.helpdesk_tickets DROP COLUMN IF EXISTS csat_sent_at;

COMMIT;
