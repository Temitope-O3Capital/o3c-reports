-- Rollback for 280 — reopen the duplicate recovery cases it retired.
--
-- Safe to run at any time. It reopens ONLY rows that migration 280 itself closed,
-- identified by duplicate_of_case_id being set together with the reason text 280 wrote.
-- A case closed by a person for any other reason is untouched, because it carries no
-- duplicate_of_case_id.
--
-- Restores status to 'active', which is what every one of these rows held before 280
-- ran (the migration only ever matched rows whose status was 'active' — it explicitly
-- excluded 'legal', and 'closed'/'recovered'/'written_off' were out of scope).
--
-- The duplicate_of_case_id COLUMN is deliberately left in place: dropping it would lose
-- the record of which pairs were found, and an unused nullable column costs nothing.

BEGIN;

UPDATE app.recovery_cases
   SET status               = 'active',
       closed_at            = NULL,
       closed_reason        = NULL,
       duplicate_of_case_id = NULL,
       updated_at           = NOW()
 WHERE duplicate_of_case_id IS NOT NULL
   AND closed_reason LIKE 'Duplicate of case %Retired by migration 280.';

COMMIT;
