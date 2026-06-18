-- Rollback for 015_schema_fixes.sql
-- Run this ONLY if you need to undo migration 015.
-- WARNING: DROP TABLE statements are destructive — back up first.

BEGIN;

-- Sequences
DROP SEQUENCE IF EXISTS los_ref_seq;
DROP SEQUENCE IF EXISTS sar_ref_seq;
DROP SEQUENCE IF EXISTS finding_ref_seq;

-- Tables added in 015
DROP TABLE IF EXISTS recovery_write_off_approvals;
DROP TABLE IF EXISTS loan_activity_log;
DROP TABLE IF EXISTS loan_comments;
DROP TABLE IF EXISTS loan_documents;
DROP TABLE IF EXISTS o3c_activity_log;
DROP TABLE IF EXISTS user_sessions;
DROP TABLE IF EXISTS o3c_custom_roles;
DROP TABLE IF EXISTS campaign_contacts;

-- Columns added to existing tables (only safe to drop if data is unimportant)
ALTER TABLE alert_rules        DROP COLUMN IF EXISTS threshold_unit;
ALTER TABLE loan_applications  DROP COLUMN IF EXISTS ref_no,
                               DROP COLUMN IF EXISTS cif,
                               DROP COLUMN IF EXISTS first_name,
                               DROP COLUMN IF EXISTS last_name,
                               DROP COLUMN IF EXISTS phone,
                               DROP COLUMN IF EXISTS email,
                               DROP COLUMN IF EXISTS loan_type,
                               DROP COLUMN IF EXISTS loan_amount,
                               DROP COLUMN IF EXISTS assigned_to,
                               DROP COLUMN IF EXISTS created_by,
                               DROP COLUMN IF EXISTS reviewed_by,
                               DROP COLUMN IF EXISTS reviewed_at;

-- FK fix: revert api_credentials.updated_by to reference users (old table name)
-- Only run if the old users table still exists
-- ALTER TABLE api_credentials DROP CONSTRAINT IF EXISTS api_credentials_updated_by_fkey;

COMMIT;
