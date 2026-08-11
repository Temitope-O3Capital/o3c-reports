-- 136_cbs_date_booked.sql
-- Adds an explicit, uniformly-named "date booked" to the CBS snapshot tables.
--
-- IMPORTANT: Udara's `dateCreated` is NOT the booking date — it is the timestamp
-- the record was imported into Udara (every row in this deployment shows the same
-- 2026-08-10 migration timestamp), and `dateCreatedFinancial` is a single
-- accounting-period date. The genuine per-account origination date is:
--   • loans  → approvedDate  (equals startDate; already parsed into approved_date/start_date)
--   • FDs    → commencementDate (already parsed into commencement_date)
-- so date_booked is sourced from those, giving one clean business-named field the
-- loan-book and FD tables can display. The 60s full-refresh sync repopulates it.

ALTER TABLE cbs_loans          ADD COLUMN IF NOT EXISTS date_booked timestamptz;
ALTER TABLE cbs_fixed_deposits ADD COLUMN IF NOT EXISTS date_booked timestamptz;

-- Backfill from the already-parsed, correctly-sourced columns (survives only until
-- the next sync run, which sets date_booked directly from the Udara payload).
UPDATE cbs_loans
   SET date_booked = COALESCE(approved_date, start_date)
 WHERE date_booked IS NULL;

UPDATE cbs_fixed_deposits
   SET date_booked = commencement_date
 WHERE date_booked IS NULL;
