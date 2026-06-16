-- Run this in Supabase SQL Editor
-- Credit Portfolio + Fixed Deposit tables

-- ── Credit Applications ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS credit_applications (
    id               BIGSERIAL PRIMARY KEY,
    date_received    DATE NOT NULL,
    customer_name    TEXT NOT NULL,
    company          TEXT,
    type             TEXT NOT NULL DEFAULT 'loan', -- loan | card
    requested_amount NUMERIC(15,2),
    status           TEXT NOT NULL DEFAULT 'pending',
    -- pending | approved | declined | incomplete | disbursed | returned | written_off
    approved_amount  NUMERIC(15,2),
    declined_reason  TEXT,
    date_processed   DATE,
    disbursed_amount NUMERIC(15,2),
    disbursed_date   DATE,
    mandate          TEXT,
    loan_id          TEXT,
    tenor            INT,             -- months
    rate             NUMERIC(5,2),    -- % per annum
    repayment_amount NUMERIC(15,2),   -- monthly
    maturity_date    DATE,
    location         TEXT,            -- Lagos | Abuja
    account_officer  TEXT,
    introducer       TEXT,
    application_type TEXT DEFAULT 'new', -- new | return
    notes            TEXT,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_apps_status   ON credit_applications(status);
CREATE INDEX IF NOT EXISTS idx_credit_apps_type     ON credit_applications(type);
CREATE INDEX IF NOT EXISTS idx_credit_apps_location ON credit_applications(location);
CREATE INDEX IF NOT EXISTS idx_credit_apps_officer  ON credit_applications(account_officer);
CREATE INDEX IF NOT EXISTS idx_credit_apps_date     ON credit_applications(date_received);

-- ── Loan Repayments ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_repayments (
    id             BIGSERIAL PRIMARY KEY,
    application_id BIGINT NOT NULL REFERENCES credit_applications(id) ON DELETE CASCADE,
    payment_month  TEXT NOT NULL,      -- e.g. 'March 2026'
    expected_amount NUMERIC(15,2),
    paid_amount    NUMERIC(15,2),
    payment_date   DATE,
    dpd            INT DEFAULT 0,      -- days past due
    payment_status TEXT DEFAULT 'pending', -- pending | partial | paid | overdue | restructured
    comment        TEXT,
    action_taken   TEXT,
    created_by     BIGINT,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repayments_app   ON loan_repayments(application_id);
CREATE INDEX IF NOT EXISTS idx_repayments_month ON loan_repayments(payment_month);

-- ── Loan Collateral ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loan_collateral (
    id                BIGSERIAL PRIMARY KEY,
    application_id    BIGINT NOT NULL REFERENCES credit_applications(id) ON DELETE CASCADE,
    security_type     TEXT,   -- personal | guarantor | cheque | vehicle
    vehicle_info      TEXT,
    last_location     TEXT,
    guarantor_name    TEXT,
    guarantor_phone   TEXT,
    guarantor_email   TEXT,
    guarantor_address TEXT,
    notes             TEXT,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Fixed Deposit Transactions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fd_transactions (
    id               BIGSERIAL PRIMARY KEY,
    transaction_date DATE NOT NULL,
    customer_name    TEXT NOT NULL,
    transaction_type TEXT NOT NULL DEFAULT 'inflow', -- inflow | liquidation
    principal        NUMERIC(15,2),   -- principal returned on liquidation
    interest_paid    NUMERIC(15,4),
    gross_amount     NUMERIC(15,2),   -- total for liquidation
    usd_amount       NUMERIC(15,4),   -- for USD-denominated FDs
    ngn_amount       NUMERIC(15,2),   -- NGN amount (inflow face value)
    currency         TEXT DEFAULT 'NGN',
    location         TEXT,            -- Lagos | Abuja
    account_officer  TEXT,
    maturity_date    DATE,
    tenor_days       INT,
    rate             NUMERIC(5,2),
    notes            TEXT,
    created_by       BIGINT,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fd_date     ON fd_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_fd_type     ON fd_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_fd_location ON fd_transactions(location);
CREATE INDEX IF NOT EXISTS idx_fd_officer  ON fd_transactions(account_officer);
