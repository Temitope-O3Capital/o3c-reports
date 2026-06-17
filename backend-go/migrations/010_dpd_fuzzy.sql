-- DPD snapshots and pg_trgm for fuzzy search

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS loan_dpd_daily_snapshot (
    id               BIGSERIAL PRIMARY KEY,
    snapshot_date    DATE   NOT NULL,
    cif_number       TEXT   NOT NULL,
    outstanding_kobo BIGINT NOT NULL,
    dpd              INT    NOT NULL,
    dpd_bucket       TEXT   NOT NULL,
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (snapshot_date, cif_number)
);
CREATE INDEX IF NOT EXISTS idx_dpd_date   ON loan_dpd_daily_snapshot(snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_dpd_cif    ON loan_dpd_daily_snapshot(cif_number, snapshot_date DESC);
CREATE INDEX IF NOT EXISTS idx_dpd_bucket ON loan_dpd_daily_snapshot(dpd_bucket, snapshot_date DESC);

-- Fuzzy search indexes on MSSQL-synced accounts table
-- These assume the "Accounts" table exists from the sync
CREATE INDEX IF NOT EXISTS idx_accounts_trgm_name
    ON "Accounts" USING GIN (("First Name" || ' ' || "Last Name") gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_accounts_trgm_phone
    ON "Accounts" USING GIN ("Phone" gin_trgm_ops);
