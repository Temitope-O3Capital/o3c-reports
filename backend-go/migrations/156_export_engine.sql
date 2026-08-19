-- 156_export_engine.sql
--
-- Backs the centralised export engine (handlers/exports.go).
--
-- Data extraction moved out of ~50 operational pages and into Reports & BI, so
-- report_export_log stops being a thin "someone ran a report" note and becomes
-- the compliance record of what left the building: which dataset, in which
-- format, how many rows, by whom, from where, and whether it succeeded.
--
-- The actor's name and role are denormalised on purpose. created_by is a FK to
-- o3c_users, and staff leave — an audit trail that reads "user 41" after the row
-- is gone is not an audit trail. Storing the name and role as they were at the
-- moment of export also preserves the truth if someone's role later changes.
--
-- Idempotent: safe to re-run.

ALTER TABLE app.report_export_log
  ADD COLUMN IF NOT EXISTS format      text,
  ADD COLUMN IF NOT EXISTS status      text,
  ADD COLUMN IF NOT EXISTS actor_name  text,
  ADD COLUMN IF NOT EXISTS actor_role  text,
  ADD COLUMN IF NOT EXISTS ip_address  text;

-- Existing rows predate the engine and were all CSV runs of the old builder.
UPDATE app.report_export_log SET format = 'csv' WHERE format IS NULL;
UPDATE app.report_export_log SET status = 'ok'  WHERE status IS NULL;

ALTER TABLE app.report_export_log ALTER COLUMN format SET DEFAULT 'csv';
ALTER TABLE app.report_export_log ALTER COLUMN status SET DEFAULT 'ok';

-- 'failed' and 'truncated' are recorded as well as 'ok'. A truncated export is
-- the interesting case: the operator holds a file that looks complete and is not.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app.report_export_log'::regclass
      AND conname  = 'report_export_log_status_chk'
  ) THEN
    ALTER TABLE app.report_export_log
      ADD CONSTRAINT report_export_log_status_chk
      CHECK (status IS NULL OR status IN ('ok','truncated','failed'));
  END IF;
END $$;

-- The log is read newest-first, and filtered to "mine" on the analyst's station.
CREATE INDEX IF NOT EXISTS idx_report_export_log_created_at
  ON app.report_export_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_export_log_actor
  ON app.report_export_log (created_by, created_at DESC);

-- ── Supporting index for the export filters ──────────────────────────────────
--
-- The card_transactions dataset can be filtered by account number over a
-- 1.1m-row table. Without this, that filter is a sequential scan (measured at
-- ~260ms per call, and an operator narrowing down a dispute makes many).
-- txn_date, cif, contact_id, account_id and mcc are already indexed; channel has
-- only three distinct values, so an index there would never be chosen.
CREATE INDEX IF NOT EXISTS idx_transactions_account_no
  ON app.transactions (account_no);

-- ── Report definitions ───────────────────────────────────────────────────────
--
-- bi_report_definitions is missing query_template, which batchRunScheduledBIReports
-- selects. That single missing column is why scheduled report delivery has never
-- run once: the batch step fails on its first query, every night.
--
-- The column is added rather than removed from the query because a saved report
-- is a definition the scheduler must be able to re-execute standalone; leaving
-- the runner to re-derive SQL from module+date_range only works while every
-- report is one of the seven built-in modules.
ALTER TABLE app.bi_report_definitions
  ADD COLUMN IF NOT EXISTS query_template text,
  ADD COLUMN IF NOT EXISTS dataset_key    text;

-- Scheduled deliveries record which schedule produced them, so a failing
-- schedule can be traced without guessing from timestamps.
ALTER TABLE app.bi_report_runs
  ADD COLUMN IF NOT EXISTS format text;

-- biRunReport wrote 'completed' while the batch runner wrote 'success' for the
-- same outcome, so "did last night's run work?" had two different answers
-- depending on which code path produced it. Normalise to 'success'.
UPDATE app.bi_report_runs SET status = 'success' WHERE status = 'completed';
