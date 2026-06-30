-- Rollback for 016_schema_fixes
-- WARNING: The loan_amount_kobo rename and type change cannot be automatically reversed
--          without data loss. Reverse manually if required.
-- WARNING: The 2028 audit_log partitions drop is safe; data in those partitions will be lost.
-- WARNING: The DPD backfill (UPDATE loan_applications SET dpd=...) cannot be undone.

DROP INDEX IF EXISTS idx_loan_apps_dpd;
ALTER TABLE loan_applications DROP COLUMN IF EXISTS dpd;

ALTER TABLE application_documents
    DROP COLUMN IF EXISTS confirmed_by,
    DROP COLUMN IF EXISTS confirmed_at;

-- Reverse o3c_custom_roles.pages JSONB → TEXT[] (manual step required if data exists)
-- ALTER TABLE o3c_custom_roles ALTER COLUMN pages TYPE TEXT[] USING ARRAY(SELECT jsonb_array_elements_text(pages));

DROP INDEX IF EXISTS idx_loan_repayments_app;
DROP INDEX IF EXISTS idx_loan_repayments_date;
DROP TABLE IF EXISTS loan_repayments;

DROP INDEX IF EXISTS idx_dpd_snapshot_date;
DROP INDEX IF EXISTS idx_dpd_snapshot_bucket;

-- Drop 2028 audit_log partitions added by this migration (adjust months as needed)
DROP TABLE IF EXISTS audit_logs_2028_01;
DROP TABLE IF EXISTS audit_logs_2028_02;
DROP TABLE IF EXISTS audit_logs_2028_03;
DROP TABLE IF EXISTS audit_logs_2028_04;
DROP TABLE IF EXISTS audit_logs_2028_05;
DROP TABLE IF EXISTS audit_logs_2028_06;
DROP TABLE IF EXISTS audit_logs_2028_07;
DROP TABLE IF EXISTS audit_logs_2028_08;
DROP TABLE IF EXISTS audit_logs_2028_09;
DROP TABLE IF EXISTS audit_logs_2028_10;
DROP TABLE IF EXISTS audit_logs_2028_11;
DROP TABLE IF EXISTS audit_logs_2028_12;
