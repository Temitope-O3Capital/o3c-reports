-- Migration 042: Active loan book tracking columns on loan_applications

ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS disbursed_at           TIMESTAMPTZ;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS disbursed_amount_kobo  BIGINT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS outstanding_kobo       BIGINT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS dpd                    INT DEFAULT 0;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS next_due_date          DATE;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS monthly_repayment_kobo BIGINT;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS maturity_date          DATE;
ALTER TABLE loan_applications ADD COLUMN IF NOT EXISTS loan_product           TEXT;

CREATE INDEX IF NOT EXISTS idx_loans_disbursed ON loan_applications(disbursed_at) WHERE disbursed_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_loans_dpd       ON loan_applications(dpd)          WHERE dpd > 0;
