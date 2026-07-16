-- Credit-card statement store.
-- Statements arrive either parsed from .txt uploads or synthesised from
-- the existing transaction tables (DualQuery path).
CREATE TABLE IF NOT EXISTS cc_statements (
    id                   BIGSERIAL PRIMARY KEY,
    customer_name        TEXT NOT NULL,
    customer_address     TEXT,
    account_number       TEXT NOT NULL,
    statement_date       DATE NOT NULL,
    payment_due_date     DATE,
    line_of_credit_kobo  BIGINT,
    opening_balance_kobo BIGINT NOT NULL DEFAULT 0,
    total_debit_kobo     BIGINT NOT NULL DEFAULT 0,
    total_credit_kobo    BIGINT NOT NULL DEFAULT 0,
    closing_balance_kobo BIGINT NOT NULL DEFAULT 0,
    min_payment_kobo     BIGINT,
    finance_charge_kobo  BIGINT,
    source               TEXT NOT NULL DEFAULT 'upload',   -- 'upload' | 'db'
    source_filename      TEXT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by           BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cc_transactions (
    id                BIGSERIAL PRIMARY KEY,
    statement_id      BIGINT NOT NULL REFERENCES cc_statements(id) ON DELETE CASCADE,
    card_pan          TEXT,
    txn_date          DATE,
    posting_date      DATE,
    trace_no          TEXT,
    description       TEXT NOT NULL,
    debit_kobo        BIGINT NOT NULL DEFAULT 0,
    credit_kobo       BIGINT NOT NULL DEFAULT 0,
    is_finance_charge BOOLEAN NOT NULL DEFAULT FALSE,
    seq               INT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_statements_account ON cc_statements (account_number);
CREATE INDEX IF NOT EXISTS idx_cc_statements_date    ON cc_statements (statement_date DESC);
CREATE INDEX IF NOT EXISTS idx_cc_txns_statement     ON cc_transactions (statement_id);
