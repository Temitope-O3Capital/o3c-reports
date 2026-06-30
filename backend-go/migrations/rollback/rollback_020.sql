-- Rollback for 020_email_config_credentials
-- WARNING: Dropping is_secret will fail if rows depend on this column with NOT NULL.
-- Set a safe default first, then drop.
ALTER TABLE api_credentials ALTER COLUMN is_secret DROP NOT NULL;
ALTER TABLE api_credentials DROP COLUMN IF EXISTS is_secret;
