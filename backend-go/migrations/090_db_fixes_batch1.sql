-- DB2: Fix loan_ref_seq seed to use MAX(id) instead of COUNT(*).
-- COUNT may be less than MAX(id) after deletes, causing duplicate reference collisions.
SELECT setval('loan_ref_seq',
  GREATEST(COALESCE((SELECT MAX(id) FROM loan_applications), 1), currval('loan_ref_seq')));

-- DB6: Rename crm_deals.expected_value to expected_value_kobo BIGINT.
-- All monetary values must be stored as kobo (BIGINT), not NUMERIC.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='crm_deals' AND column_name='expected_value'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='crm_deals' AND column_name='expected_value_kobo'
  ) THEN
    ALTER TABLE crm_deals
      ADD COLUMN expected_value_kobo BIGINT;
    -- Backfill: convert Naira NUMERIC to kobo BIGINT
    UPDATE crm_deals SET expected_value_kobo = ROUND(expected_value * 100)::BIGINT
      WHERE expected_value IS NOT NULL;
    ALTER TABLE crm_deals DROP COLUMN expected_value;
  END IF;
END $$;

-- DB7: Index on audit_logs(actor_id, created_at DESC) for per-user audit queries.
-- PostgreSQL propagates this index to all range partitions automatically.
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_date
  ON audit_logs(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- DB11: Add missing timestamp columns to payroll_items.
ALTER TABLE payroll_items
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- DB12: Add FK settings.updated_by → o3c_users(id).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='settings' AND column_name='updated_by')
  AND (SELECT data_type FROM information_schema.columns WHERE table_name='settings' AND column_name='updated_by') = 'text'
  THEN
    ALTER TABLE settings DROP COLUMN updated_by;
  END IF;
END $$;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS updated_by BIGINT REFERENCES o3c_users(id) ON DELETE SET NULL;
