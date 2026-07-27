-- 102: collections watchlist, collections write-off requests, recovery payment approval

-- Watchlist: flag customers for early escalation even below 90 DPD
CREATE TABLE IF NOT EXISTS collections_watchlist (
    id               BIGSERIAL PRIMARY KEY,
    account_cif      TEXT        NOT NULL,
    flagged_by       BIGINT      REFERENCES o3c_users(id),
    scenario         TEXT        NOT NULL CHECK (scenario IN (
                         'unreachable','legal_threat','dispute',
                         'employer_terminated','property_risk','other')),
    notes            TEXT,
    dpd_at_flag      INT,
    outstanding_kobo BIGINT,
    status           TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','resolved','escalated_to_recovery')),
    resolved_at      TIMESTAMPTZ,
    resolved_by      BIGINT      REFERENCES o3c_users(id),
    resolution_notes TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coll_watchlist_cif    ON collections_watchlist (account_cif);
CREATE INDEX IF NOT EXISTS idx_coll_watchlist_status ON collections_watchlist (status);

-- Collections-initiated write-off requests (separate from recovery_write_off_approvals)
CREATE TABLE IF NOT EXISTS collections_writeoff_requests (
    id                  BIGSERIAL PRIMARY KEY,
    account_cif         TEXT        NOT NULL,
    loan_application_id BIGINT,
    requested_by        BIGINT      REFERENCES o3c_users(id),
    writeoff_type       TEXT        NOT NULL CHECK (writeoff_type IN (
                            'full','partial_amount','percentage',
                            'principal_only','interest_only')),
    reason              TEXT        NOT NULL CHECK (reason IN (
                            'bad_debt','deceased','fraud',
                            'natural_disaster','regulatory','other')),
    reason_notes        TEXT,
    amount_kobo         BIGINT,           -- used for writeoff_type = partial_amount
    percentage          NUMERIC(5,2),     -- used for writeoff_type = percentage
    outstanding_kobo    BIGINT,           -- snapshot of outstanding at time of request
    status              TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','approved','rejected')),
    reviewed_by         BIGINT      REFERENCES o3c_users(id),
    reviewed_at         TIMESTAMPTZ,
    review_notes        TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coll_wo_req_cif    ON collections_writeoff_requests (account_cif);
CREATE INDEX IF NOT EXISTS idx_coll_wo_req_status ON collections_writeoff_requests (status);

-- Add approval workflow columns to recovery_payments
-- Existing rows keep DEFAULT 'approved' (they already had GL posted)
-- New rows will be inserted with explicit status='pending'
ALTER TABLE recovery_payments
    ADD COLUMN IF NOT EXISTS status           TEXT        NOT NULL DEFAULT 'approved',
    ADD COLUMN IF NOT EXISTS approved_by      BIGINT      REFERENCES o3c_users(id),
    ADD COLUMN IF NOT EXISTS approved_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_rec_payments_status ON recovery_payments (status);
