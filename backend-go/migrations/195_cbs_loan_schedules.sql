-- Loan repayment schedules from Udara (GET /api/LoanAccount/v1/viewloanschedule →
-- paymentSchedules[]). The Search endpoint returns paymentSchedules null; only the
-- per-loan schedule endpoint fills it. One row per installment.
--
-- The per-installment `interest` is the loan-side REVENUE: recognised as EARNED once
-- has_processed is true (the borrower has paid that installment), and as EXPECTED/
-- scheduled by payment_date until then. Amounts arrive already in kobo. payment_date
-- is the installment's value date (Udara paymentDate_Date), the correct key for period
-- income — never the sync/entry time.
CREATE TABLE IF NOT EXISTS app.cbs_loan_schedules (
    loan_account_number TEXT        NOT NULL,
    cbs_customer_id     TEXT,
    payment_date        DATE        NOT NULL,
    principal_kobo      BIGINT      NOT NULL DEFAULT 0,
    interest_kobo       BIGINT      NOT NULL DEFAULT 0,
    fee_kobo            BIGINT      NOT NULL DEFAULT 0,
    payment_status      TEXT,
    has_processed       BOOLEAN     NOT NULL DEFAULT FALSE,
    interest_id         TEXT,
    synced_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (loan_account_number, payment_date)
);

CREATE INDEX IF NOT EXISTS idx_cbs_loan_sched_date      ON app.cbs_loan_schedules (payment_date);
CREATE INDEX IF NOT EXISTS idx_cbs_loan_sched_processed ON app.cbs_loan_schedules (has_processed, payment_date);
CREATE INDEX IF NOT EXISTS idx_cbs_loan_sched_cif       ON app.cbs_loan_schedules (cbs_customer_id);
