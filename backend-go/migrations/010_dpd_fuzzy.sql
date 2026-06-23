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

-- Fuzzy search indexes on MSSQL-synced accounts table.
-- Existing Supabase-only installs may have an "Accounts" table with a partial
-- column set, so guard each index by the exact columns it needs.
DO $$
BEGIN
    IF to_regclass('"Accounts"') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Accounts' AND column_name='First Name')
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Accounts' AND column_name='Last Name') THEN
        CREATE INDEX IF NOT EXISTS idx_accounts_trgm_name
            ON "Accounts" USING GIN (("First Name" || ' ' || "Last Name") gin_trgm_ops);
    END IF;

    IF to_regclass('"Accounts"') IS NOT NULL
       AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='Accounts' AND column_name='Phone') THEN
        CREATE INDEX IF NOT EXISTS idx_accounts_trgm_phone
            ON "Accounts" USING GIN ("Phone" gin_trgm_ops);
    END IF;
END $$;
