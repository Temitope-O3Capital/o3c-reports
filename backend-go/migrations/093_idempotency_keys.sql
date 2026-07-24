-- A9: Idempotency key table for financial mutation endpoints.
-- Prevents double-disbursement, double-repayment, and double-FD creation on retry.
-- Usage: client sends Idempotency-Key: <uuid> header; server checks/stores here.

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id               BIGSERIAL    PRIMARY KEY,
    idempotency_key  TEXT         NOT NULL,
    user_id          BIGINT       NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
    operation        TEXT         NOT NULL,     -- e.g. 'disburse_loan', 'record_repayment', 'create_fd'
    response_status  INT,                       -- NULL until completed
    response_body    TEXT,                      -- cached JSON response
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    completed_at     TIMESTAMPTZ,
    UNIQUE (idempotency_key, user_id, operation)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
    ON idempotency_keys(created_at DESC);

-- TTL: keys older than 24 hours are not replayed (clients retry within a session).
-- Cleanup is handled by the nightly TTL goroutine in main.go.
-- Add an expires_at for the goroutine to use:
ALTER TABLE idempotency_keys
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
        NOT NULL DEFAULT (NOW() + INTERVAL '24 hours');

CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
    ON idempotency_keys(expires_at);
