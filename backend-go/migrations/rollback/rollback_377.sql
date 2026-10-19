-- Undo 377: drop the per-schedule subject, note and attach choice.
--
-- THIS LOSES DATA, unlike most of the rollbacks here. Any subject or note somebody has
-- typed against a schedule lives only in these columns, and dropping them discards it
-- with no copy anywhere. Export them first if the schedules are in use:
--
--     SELECT id, report_id, subject, message, attach FROM app.pivot_report_schedules
--      WHERE subject IS NOT NULL OR message IS NOT NULL OR attach IS NOT TRUE;
--
-- At the time of writing that query returns nothing: pivot_report_schedules holds 0 rows,
-- so this is currently free. Re-run it before you trust that.
--
-- ORDER MATTERS, and the safe order is the opposite of 376's. The columns are only READ
-- by the new binary, never required by the old one, so dropping them under a running new
-- binary makes scheduled sends fail on the next tick. Roll the binary back first.
--
-- What it does NOT undo: nothing else. 377 touched no other table, and the subject
-- fallback in emailReport works with or without these columns, because a blank subject
-- has always meant "generate one".

BEGIN;

ALTER TABLE app.pivot_report_schedules
    DROP CONSTRAINT IF EXISTS pivot_report_schedules_subject_len;

ALTER TABLE app.pivot_report_schedules
    DROP COLUMN IF EXISTS subject,
    DROP COLUMN IF EXISTS message,
    DROP COLUMN IF EXISTS attach;

COMMIT;
