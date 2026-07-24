-- 094_interest_rate_units — M41: document interest rate unit convention
--
-- CHOSEN STANDARD (M41):
--   loan_applications.interest_rate_bps  — INT, basis points (e.g. 1250 = 12.50 %)
--   fd_transactions.rate                 — NUMERIC, percent   (e.g. 12.5  = 12.50 %)
--
-- Loans use BPS because that was established in migration 004.
-- FD uses percent because it is imported from MSSQL/Excel where the value is already
-- a percent. Converting FD to BPS requires a data migration that is deferred until
-- the FD module is fully owned by this system (currently partially MSSQL-synced).
--
-- In application code:
--   - When reading loan rate: rate_pct = interest_rate_bps / 100.0
--   - When reading FD rate:   rate_pct = rate  (already percent)
--   - Never mix the two fields without an explicit unit conversion.

COMMENT ON COLUMN fd_transactions.rate IS
  'Annual interest rate as a PERCENTAGE (e.g. 12.5 = 12.5%). '
  'See loan_applications.interest_rate_bps for the basis-points equivalent used in loans.';

COMMENT ON COLUMN loan_applications.interest_rate_bps IS
  'Annual interest rate in BASIS POINTS (e.g. 1250 = 12.50%). '
  'See fd_transactions.rate for the percentage equivalent used in FDs.';
