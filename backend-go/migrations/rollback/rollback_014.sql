-- Rollback for 014_users_table.sql
BEGIN;
DROP TABLE IF EXISTS o3c_users CASCADE;
COMMIT;
