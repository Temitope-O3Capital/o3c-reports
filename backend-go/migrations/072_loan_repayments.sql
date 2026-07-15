-- 072_loan_repayments  (reconciling rewrite)
--
-- Two migrations/contributors define loan_repayments differently:
--   016_schema_fixes.sql created it with application_id (NOT NULL) + payment_method.
--   This migration + handlers/active_loan_book.go use loan_id + channel + notes.
-- Both id columns are the same FK (loan_applications.id) under different names, so
-- credit_portfolio.go/reports.go (application_id) and active_loan_book.go (loan_id)
-- were on divergent schemas. The original 072 assumed loan_id and aborted startup
-- against the 016 table ("column loan_id does not exist").
--
-- Fix: support BOTH names, backfilled and kept in sync by a trigger, so every
-- handler works regardless of which it queries. Fully idempotent.

-- Fresh database: create with the full, reconciled shape.
CREATE TABLE IF NOT EXISTS loan_repayments (
    id              BIGSERIAL PRIMARY KEY,
    loan_id         BIGINT REFERENCES loan_applications(id) ON DELETE CASCADE,
    application_id  BIGINT REFERENCES loan_applications(id) ON DELETE CASCADE,
    amount_kobo     BIGINT NOT NULL CHECK (amount_kobo > 0),
    payment_date    DATE NOT NULL DEFAULT CURRENT_DATE,
    reference       TEXT,
    channel         TEXT NOT NULL DEFAULT 'manual',
    payment_method  TEXT,
    notes           TEXT,
    recorded_by     BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing database (table came from 016): add whatever columns are missing.
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS loan_id        BIGINT REFERENCES loan_applications(id) ON DELETE CASCADE;
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS application_id BIGINT REFERENCES loan_applications(id) ON DELETE CASCADE;
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS channel        TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE loan_repayments ADD COLUMN IF NOT EXISTS notes          TEXT;

-- Backfill each id from the other for rows that predate the reconciliation.
UPDATE loan_repayments SET loan_id        = application_id WHERE loan_id        IS NULL AND application_id IS NOT NULL;
UPDATE loan_repayments SET application_id = loan_id        WHERE application_id IS NULL AND loan_id        IS NOT NULL;

-- Keep the two id names in sync on every write, so a handler that supplies only
-- one always leaves both populated (and 016's NOT NULL on application_id is met).
CREATE OR REPLACE FUNCTION loan_repayments_sync_ids() RETURNS trigger AS $$
BEGIN
    IF NEW.loan_id        IS NULL THEN NEW.loan_id        := NEW.application_id; END IF;
    IF NEW.application_id IS NULL THEN NEW.application_id := NEW.loan_id;        END IF;
    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_loan_repayments_sync ON loan_repayments;
CREATE TRIGGER trg_loan_repayments_sync
    BEFORE INSERT OR UPDATE ON loan_repayments
    FOR EACH ROW EXECUTE FUNCTION loan_repayments_sync_ids();

CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan ON loan_repayments(loan_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_app  ON loan_repayments(application_id);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_date ON loan_repayments(payment_date DESC);
