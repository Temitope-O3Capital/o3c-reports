-- 155: Multi-product sales targets.
--
-- sales_targets carried only loan_count + disbursement_kobo, but Sales owns fixed
-- deposits and cards on par with credit (CLAUDE.md). Now that Udara data is live
-- (cbs_loans / cbs_fixed_deposits), actuals can be reconciled per officer via the CIFs
-- they own (customer_officers.cif = cbs_*.cbs_customer_id), so targets get FD columns
-- alongside the existing loan ones. Cards are counted from the card book (app.accounts)
-- and need no new target column yet.
--
-- Additive + idempotent; existing rows default to 0.

ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS fd_count       INT    NOT NULL DEFAULT 0;
ALTER TABLE sales_targets ADD COLUMN IF NOT EXISTS fd_amount_kobo BIGINT NOT NULL DEFAULT 0;
