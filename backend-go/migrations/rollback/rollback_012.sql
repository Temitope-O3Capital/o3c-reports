-- Rollback for 012_api_credentials.sql
BEGIN;
DROP TABLE IF EXISTS api_credentials CASCADE;
COMMIT;
