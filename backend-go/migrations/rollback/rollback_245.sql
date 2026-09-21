-- Rollback 245_upload_ledger.sql
--
-- Afterwards GET /api/uploads/audit returns 500 again (as it did before 245), and
-- recordUpload logs a warning per upload instead of writing a row. Neither breaks
-- an import.

DROP INDEX IF EXISTS app.idx_upload_audit_log_type_time;
DROP TABLE IF EXISTS app.upload_audit_log;
