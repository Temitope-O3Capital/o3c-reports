-- 204: give app.collection_assignments real columns for the loan fields that the
-- Loan Repayment CRM upload carries, instead of cramming them into the notes text.
-- Mirrors the loan columns already on recovery_cases (migration 181) and adds the
-- repayment/rate/debit-day/tenor/disbursement the collections sheet also tracks.
-- Additive + idempotent; all nullable (cards leave them NULL).

ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS loan_ref          text;   -- Mandate ID
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS officer_name      text;   -- account officer (free text; not a system user)
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS loan_tenor        text;   -- as written on the sheet (unit not asserted)
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS repayment_kobo    bigint; -- periodic repayment amount
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS loan_rate         text;   -- rate as written (e.g. '2' = 2%)
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS debit_day         text;   -- direct-debit day / status note (e.g. '5', 'RESTRUCTURED/5')
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS disbursement_date date;
ALTER TABLE app.collection_assignments ADD COLUMN IF NOT EXISTS maturity_date     date;
