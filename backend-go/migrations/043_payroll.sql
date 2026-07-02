-- Migration 043: Payroll runs, items, and payslips

CREATE TABLE IF NOT EXISTS payroll_runs (
    id                  BIGSERIAL PRIMARY KEY,
    period_year         INT  NOT NULL,
    period_month        INT  NOT NULL CHECK (period_month BETWEEN 1 AND 12),
    status              TEXT NOT NULL DEFAULT 'draft', -- draft | review | approved | paid
    headcount           INT  NOT NULL DEFAULT 0,
    total_gross_kobo    BIGINT NOT NULL DEFAULT 0,
    total_net_kobo      BIGINT NOT NULL DEFAULT 0,
    total_paye_kobo     BIGINT NOT NULL DEFAULT 0,
    total_pension_kobo  BIGINT NOT NULL DEFAULT 0,
    total_nhf_kobo      BIGINT NOT NULL DEFAULT 0,
    total_loan_deduction_kobo BIGINT NOT NULL DEFAULT 0,
    notes               TEXT,
    created_by          BIGINT REFERENCES users(id),
    approved_by         BIGINT REFERENCES users(id),
    approved_at         TIMESTAMPTZ,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(period_year, period_month)
);

CREATE TABLE IF NOT EXISTS payroll_items (
    id                   BIGSERIAL PRIMARY KEY,
    run_id               BIGINT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
    employee_id          BIGINT NOT NULL REFERENCES employees(id),
    employee_name        TEXT   NOT NULL,
    staff_id             TEXT,
    department           TEXT,
    grade_level          TEXT,
    job_title            TEXT,
    bank_name            TEXT,
    account_number       TEXT,
    gross_kobo           BIGINT NOT NULL DEFAULT 0,
    basic_kobo           BIGINT NOT NULL DEFAULT 0,
    housing_kobo         BIGINT NOT NULL DEFAULT 0,
    transport_kobo       BIGINT NOT NULL DEFAULT 0,
    other_allowance_kobo BIGINT NOT NULL DEFAULT 0,
    paye_kobo            BIGINT NOT NULL DEFAULT 0,
    employee_pension_kobo BIGINT NOT NULL DEFAULT 0,
    nhf_kobo             BIGINT NOT NULL DEFAULT 0,
    loan_deduction_kobo  BIGINT NOT NULL DEFAULT 0,
    other_deduction_kobo BIGINT NOT NULL DEFAULT 0,
    net_kobo             BIGINT NOT NULL DEFAULT 0,
    notes                TEXT,
    UNIQUE(run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_items(run_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_period ON payroll_runs(period_year, period_month);
