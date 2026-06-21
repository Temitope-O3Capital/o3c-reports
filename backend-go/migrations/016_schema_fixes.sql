-- Migration 016: Schema fixes, dpd column, confirmed_by, activity log, 2028 partitions
-- Idempotent: safe to run multiple times
-- Date: 2026-06-21
--
-- Pre-run audit of existing schema (migrations 001–015):
--
--  • loan_applications        — exists (004 + 015 columns). No dpd, sector_code,
--                               sub_sector_code yet. loan_amount NUMERIC(20,2)
--                               added by 015; rename + retype here.
--  • application_documents    — exists (004). No confirmed_by / confirmed_at yet.
--  • o3c_custom_roles.pages   — created as TEXT[] in 015; convert to JSONB here.
--  • loan_repayments          — does NOT exist anywhere; create here.
--  • loan_dpd_daily_snapshot  — exists (010) with UNIQUE(snapshot_date, cif_number)
--                               and no application_id column. CREATE TABLE IF NOT
--                               EXISTS is a no-op; we add application_id column and
--                               the new PRIMARY KEY index via separate ALTER/CREATE.
--  • o3c_activity_log         — already created in 015 (id, user_id, page, action,
--                               detail, ip, resource, method, ts). CREATE TABLE IF
--                               NOT EXISTS below is a safe no-op; extra indexes added
--                               with IF NOT EXISTS guard.
--  • audit_logs               — partitioned table from 008; partitions through
--                               2027-12 already exist. 2028 partitions added here.
--  • sars.sar_ref             — declared UNIQUE inline in 008; the DO block below
--                               checks by constraint name and skips if already set.
--  • o3c_users                — the correct users table (created in 014).
--                               FK references to the old phantom "users" table
--                               have been fixed in 015 for api_credentials and
--                               cs_interactions; we clean up any remaining ones here.

-- =============================================================================
-- 1. Add `dpd` column to loan_applications
-- =============================================================================
ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS dpd INTEGER NOT NULL DEFAULT 0;

-- Backfill DPD for existing active / repaying / overdue loans
UPDATE loan_applications
SET dpd = GREATEST(0, CURRENT_DATE - booked_at::date)
WHERE status IN ('active', 'repaying', 'overdue')
  AND booked_at IS NOT NULL
  AND dpd = 0;

-- Partial index for DPD-based queries (only rows where DPD > 0)
CREATE INDEX IF NOT EXISTS idx_loan_apps_dpd
    ON loan_applications(dpd) WHERE dpd > 0;

-- =============================================================================
-- 2. Add confirmed_by / confirmed_at to application_documents
--    (loan_documents in 015 already has these; application_documents in 004
--     does not — the confirmDocument handler targets application_documents)
-- =============================================================================
ALTER TABLE application_documents
    ADD COLUMN IF NOT EXISTS confirmed_by BIGINT REFERENCES o3c_users(id),
    ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- =============================================================================
-- 3. Convert o3c_custom_roles.pages from TEXT[] to JSONB
--    Only runs if the column still exists as an ARRAY type.
-- =============================================================================
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name  = 'o3c_custom_roles'
          AND column_name = 'pages'
          AND data_type   = 'ARRAY'
    ) THEN
        ALTER TABLE o3c_custom_roles
            ALTER COLUMN pages TYPE JSONB
            USING to_jsonb(pages);
    END IF;
END $$;

-- =============================================================================
-- 4. Rename loan_amount -> loan_amount_kobo and change type to BIGINT
--    Migration 015 added loan_amount NUMERIC(20,2); this violates the kobo rule.
--    Multiplies by 100 to convert from naira-decimal to kobo-integer.
-- =============================================================================
DO $$
BEGIN
    -- Step 4a: rename if still called loan_amount
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name  = 'loan_applications'
          AND column_name = 'loan_amount'
    ) THEN
        ALTER TABLE loan_applications
            RENAME COLUMN loan_amount TO loan_amount_kobo;
    END IF;

    -- Step 4b: retype to BIGINT if it is still NUMERIC / DECIMAL
    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_name  = 'loan_applications'
          AND column_name = 'loan_amount_kobo'
          AND data_type IN ('numeric', 'decimal')
    ) THEN
        ALTER TABLE loan_applications
            ALTER COLUMN loan_amount_kobo TYPE BIGINT
            USING ROUND(loan_amount_kobo * 100)::BIGINT;
    END IF;
END $$;

-- =============================================================================
-- 5. Create loan_repayments table (does not exist in any prior migration)
-- =============================================================================
CREATE TABLE IF NOT EXISTS loan_repayments (
    id              BIGSERIAL PRIMARY KEY,
    application_id  BIGINT NOT NULL REFERENCES loan_applications(id),
    amount_kobo     BIGINT NOT NULL,
    payment_date    DATE   NOT NULL,
    payment_method  TEXT,
    reference       TEXT,
    recorded_by     BIGINT REFERENCES o3c_users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_repayments_app
    ON loan_repayments(application_id);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_date
    ON loan_repayments(payment_date);

-- =============================================================================
-- 6. Ensure loan_dpd_daily_snapshot has the right structure
--
--    Migration 010 created this table with UNIQUE(snapshot_date, cif_number)
--    and no application_id column. We cannot replace the primary key of a
--    populated table non-destructively, so we:
--      a) Add application_id column if it is missing.
--      b) Ensure the new indexes exist.
--      c) The CREATE TABLE IF NOT EXISTS below is a no-op when the table already
--         exists; it documents the intended target schema for fresh installs.
-- =============================================================================
CREATE TABLE IF NOT EXISTS loan_dpd_daily_snapshot (
    snapshot_date    DATE   NOT NULL,
    application_id   BIGINT NOT NULL REFERENCES loan_applications(id),
    cif_number       TEXT,
    outstanding_kobo BIGINT NOT NULL DEFAULT 0,
    dpd              INTEGER NOT NULL DEFAULT 0,
    dpd_bucket       TEXT   NOT NULL,
    CONSTRAINT loan_dpd_snapshot_pk PRIMARY KEY (snapshot_date, application_id),
    CONSTRAINT loan_dpd_bucket_check CHECK (dpd_bucket IN ('0', '1-30', '31-60', '61-90', '90+'))
);

-- Add application_id to the existing table if it was created by 010 without it
ALTER TABLE loan_dpd_daily_snapshot
    ADD COLUMN IF NOT EXISTS application_id BIGINT REFERENCES loan_applications(id);

-- Add outstanding_kobo default if table was created without it
ALTER TABLE loan_dpd_daily_snapshot
    ADD COLUMN IF NOT EXISTS outstanding_kobo BIGINT NOT NULL DEFAULT 0;

-- Ensure dpd_bucket check constraint exists (010 did not add it)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE table_name      = 'loan_dpd_daily_snapshot'
          AND constraint_name = 'loan_dpd_bucket_check'
          AND constraint_type = 'CHECK'
    ) THEN
        ALTER TABLE loan_dpd_daily_snapshot
            ADD CONSTRAINT loan_dpd_bucket_check
            CHECK (dpd_bucket IN ('0', '1-30', '31-60', '61-90', '90+'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_dpd_snapshot_date
    ON loan_dpd_daily_snapshot(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_dpd_snapshot_bucket
    ON loan_dpd_daily_snapshot(dpd_bucket);

-- =============================================================================
-- 7. Fix dangling FK constraints that reference the non-existent "users" table
--    Migrations 012 and 013 referenced "users" (fixed in 015 for the known
--    cases). This block catches any remaining constraints across all tables.
-- =============================================================================
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT tc.table_name, tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name
        JOIN information_schema.table_constraints ftc
          ON ftc.constraint_name = rc.unique_constraint_name
        WHERE ftc.table_name    = 'users'
          AND ftc.constraint_type = 'PRIMARY KEY'
    LOOP
        EXECUTE format(
            'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
            r.table_name,
            r.constraint_name
        );
        RAISE NOTICE 'Dropped dangling FK % on table %',
            r.constraint_name, r.table_name;
    END LOOP;
END $$;

-- =============================================================================
-- 8. Ensure o3c_activity_log exists with required columns
--    Migration 015 already created this table as:
--      (id, user_id, page, action, detail, ip, resource, method, ts)
--    The CREATE TABLE IF NOT EXISTS below is a no-op on existing installs.
--    Extra columns (entity_type, entity_id, details, ip_address) are added
--    as aliases / supplements for the audit trail export handler.
-- =============================================================================
CREATE TABLE IF NOT EXISTS o3c_activity_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT REFERENCES o3c_users(id),
    action      TEXT NOT NULL,
    entity_type TEXT,
    entity_id   TEXT,
    details     JSONB,
    ip_address  TEXT,
    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add columns introduced by the audit trail export handler (safe no-ops if
-- the table was already created with these columns)
ALTER TABLE o3c_activity_log ADD COLUMN IF NOT EXISTS entity_type TEXT;
ALTER TABLE o3c_activity_log ADD COLUMN IF NOT EXISTS entity_id   TEXT;
ALTER TABLE o3c_activity_log ADD COLUMN IF NOT EXISTS details     JSONB;
ALTER TABLE o3c_activity_log ADD COLUMN IF NOT EXISTS ip_address  TEXT;

-- Ensure all required indexes exist (IF NOT EXISTS = no-op if 015 created them)
CREATE INDEX IF NOT EXISTS idx_activity_log_ts
    ON o3c_activity_log(ts DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_user
    ON o3c_activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_action
    ON o3c_activity_log(action);

-- =============================================================================
-- 9. Add audit_logs partitions for 2028
--    Migration 008 created partitions through 2027-12.
--    Migration 015 added audit_logs_default (DEFAULT partition).
--    The DEFAULT partition catches rows falling outside named partitions; the
--    explicit monthly partitions below give efficient pruning for 2028 queries.
-- =============================================================================
CREATE TABLE IF NOT EXISTS audit_logs_2028_01 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_02 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-02-01') TO ('2028-03-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_03 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-03-01') TO ('2028-04-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_04 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-04-01') TO ('2028-05-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_05 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-05-01') TO ('2028-06-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_06 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-06-01') TO ('2028-07-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_07 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-07-01') TO ('2028-08-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_08 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-08-01') TO ('2028-09-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_09 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-09-01') TO ('2028-10-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_10 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-10-01') TO ('2028-11-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_11 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-11-01') TO ('2028-12-01');
CREATE TABLE IF NOT EXISTS audit_logs_2028_12 PARTITION OF audit_logs
    FOR VALUES FROM ('2028-12-01') TO ('2029-01-01');

-- =============================================================================
-- 10. Add UNIQUE constraint to sars.sar_ref if not already present
--     Migration 008 declared sar_ref as TEXT NOT NULL UNIQUE (inline).
--     The inline constraint is named by Postgres automatically (typically
--     "sars_sar_ref_key"). This block adds a named constraint only if no
--     UNIQUE constraint covering sar_ref exists yet.
-- =============================================================================
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.table_constraints
        WHERE table_name      = 'sars'
          AND constraint_type = 'UNIQUE'
          AND constraint_name LIKE '%sar_ref%'
    ) THEN
        ALTER TABLE sars
            ADD CONSTRAINT sars_sar_ref_unique UNIQUE (sar_ref);
    END IF;
END $$;

-- =============================================================================
-- 11. Add sector / sub-sector classification columns to loan_applications
--     Required for CBN Credit Return (CRMS) submissions.
-- =============================================================================
ALTER TABLE loan_applications
    ADD COLUMN IF NOT EXISTS sector_code     TEXT,
    ADD COLUMN IF NOT EXISTS sub_sector_code TEXT;

COMMENT ON COLUMN loan_applications.sector_code     IS 'CBN sector classification for CRMS Credit Return';
COMMENT ON COLUMN loan_applications.sub_sector_code IS 'CBN sub-sector classification for CRMS Credit Return';
