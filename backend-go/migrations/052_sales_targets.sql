-- Migration 052: Sales Targets (Wave 5G)

CREATE TABLE IF NOT EXISTS sales_targets (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT       NOT NULL REFERENCES o3c_users(id) ON DELETE CASCADE,
    period          TEXT         NOT NULL,   -- 'YYYY-MM'
    loan_count      INT          NOT NULL DEFAULT 0,
    disbursement_kobo BIGINT     NOT NULL DEFAULT 0,
    notes           TEXT         NOT NULL DEFAULT '',
    created_by      BIGINT       REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, period)
);

CREATE INDEX IF NOT EXISTS idx_st_period  ON sales_targets(period);
CREATE INDEX IF NOT EXISTS idx_st_user    ON sales_targets(user_id);
