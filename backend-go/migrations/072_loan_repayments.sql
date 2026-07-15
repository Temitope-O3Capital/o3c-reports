CREATE TABLE IF NOT EXISTS loan_repayments (
    id              BIGSERIAL PRIMARY KEY,
    loan_id         BIGINT NOT NULL REFERENCES loan_applications(id) ON DELETE CASCADE,
    amount_kobo     BIGINT NOT NULL CHECK (amount_kobo > 0),
    payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    reference       TEXT,
    channel         TEXT NOT NULL DEFAULT 'manual',
    notes           TEXT,
    recorded_by     BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan ON loan_repayments(loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_date ON loan_repayments(payment_date DESC);
